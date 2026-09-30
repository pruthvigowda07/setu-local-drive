using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Drawing;
using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class Program {
    [STAThread] static void Main(string[] args) {
        var data=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Harbor", "Data");
        try { Directory.CreateDirectory(data); File.AppendAllText(Path.Combine(data,"desktop.log"), "Setu process entered Main " + DateTime.Now + Environment.NewLine); } catch { }
        bool created;
        using (var mutex = new Mutex(true, "Local.Setu.Desktop." + Environment.UserName, out created)) {
            if (!created) {
                try { using (var signal = EventWaitHandle.OpenExisting("Local.Setu.Open." + Environment.UserName)) signal.Set(); }
                catch { MessageBox.Show("Setu is already starting. Try the shortcut again in a moment.", "Setu"); }
                return;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try { using (var app = new SetuContext(Array.IndexOf(args,"--no-browser") < 0)) Application.Run(app); }
            catch (Exception e) {
                try { File.AppendAllText(Path.Combine(data,"desktop.log"), "Setu fatal startup failure: " + e + Environment.NewLine); } catch { }
                MessageBox.Show(e.Message, "Setu could not start", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }
}

internal sealed class SetuContext : ApplicationContext {
    readonly string root = AppDomain.CurrentDomain.BaseDirectory;
    readonly string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Harbor", "Data");
    readonly NotifyIcon tray;
    readonly System.Windows.Forms.Timer timer;
    readonly EventWaitHandle openSignal;
    readonly Process server;
    readonly CookieContainer cookies = new CookieContainer();
    readonly bool openBrowser;
    readonly object logLock = new object();
    volatile bool ready;
    bool stopping, opened;
    string ownerKey;
    Form window;
    WebView2 webView;
    bool desktopRendered;
    const string Origin = "http://127.0.0.1:4783";
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
    void ApplyTheme(bool dark) {
        var color=dark?Color.FromArgb(7,7,7):Color.FromArgb(245,247,250);
        window.BackColor=color;window.ForeColor=dark?Color.FromArgb(255,241,229):Color.FromArgb(25,35,50);
        if(webView!=null)webView.DefaultBackgroundColor=color;
        try {int value=dark?1:0;DwmSetWindowAttribute(window.Handle,20,ref value,4);}catch{}
    }

    public SetuContext(bool open) {
        openBrowser = open;
        Directory.CreateDirectory(data);
        openSignal = new EventWaitHandle(false, EventResetMode.AutoReset, "Local.Setu.Open." + Environment.UserName);
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open dashboard", null, (s,e) => OpenDashboard());
        menu.Items.Add("Open app data folder", null, (s,e) => Process.Start(new ProcessStartInfo(data) { UseShellExecute = true }));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Pause receiving", null, (s,e) => {
            try { Post("/api/receiving", "{\"minutes\":0}"); tray.ShowBalloonTip(2500,"Setu","Receiving paused. Remote tunnel closed.",ToolTipIcon.Info); }
            catch(Exception error) { MessageBox.Show(error.Message,"Setu"); }
        });
        menu.Items.Add("Exit Setu", null, (s,e) => ExitThread());
        tray = new NotifyIcon { Text="Setu - starting", ContextMenuStrip=menu, Visible=true,
            Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath) };
        tray.DoubleClick += (s,e) => OpenDashboard();
        var start = new ProcessStartInfo(Path.Combine(root,"runtime","node.exe"), "\"" + Path.Combine(root,"server","main.js") + "\" --quiet") {
            WorkingDirectory=root, UseShellExecute=false, CreateNoWindow=true, RedirectStandardOutput=true, RedirectStandardError=true
        };
        start.EnvironmentVariables["LOCAL_DATA_DIR"] = data;
        start.EnvironmentVariables["PORT"] = "4783";
        start.EnvironmentVariables["DEFAULT_INBOX_DIR"] = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Harbor Inbox");
        start.EnvironmentVariables["CLOUDFLARED_PATH"] = Path.Combine(root,"runtime","cloudflared.exe");
        // The installer persists the chosen folder. New installations use a Windows Documents folder.
        start.EnvironmentVariables.Remove("INBOX_DIR");
        File.WriteAllText(Path.Combine(data,"desktop.log"), "Setu desktop started " + DateTime.Now + Environment.NewLine);
        server = new Process { StartInfo=start };
        server.OutputDataReceived += (s,e) => {
            if(e.Data == null) return;
            if(e.Data.StartsWith("Setu is running at " + Origin)) ready=true;
            else Log(e.Data);
        };
        server.ErrorDataReceived += (s,e) => { if(e.Data != null) Log(e.Data); };
        server.Start();server.BeginOutputReadLine();server.BeginErrorReadLine();
        timer=new System.Windows.Forms.Timer { Interval=400 };
        timer.Tick += (s,e) => {
            if(stopping)return;
            if(server.HasExited) {
                tray.Visible=false;
                MessageBox.Show("Setu stopped or could not start. If another local instance is using port 4783, close it first. Details are in " + Path.Combine(data,"desktop.log"),"Setu",MessageBoxButtons.OK,MessageBoxIcon.Information);
                ExitThread();return;
            }
            if(ready && !opened) {
                opened=true;tray.Text="Setu - running locally";
                if(openBrowser)OpenDashboard();
                else tray.ShowBalloonTip(2500,"Setu","Running locally. Double-click this icon to open the dashboard.",ToolTipIcon.Info);
            }
            if(openSignal.WaitOne(0))OpenDashboard();
        };
        timer.Start();
    }
    void Log(string text) { lock(logLock) { try {File.AppendAllText(Path.Combine(data,"desktop.log"),text+Environment.NewLine);} catch {} } }
    void LogException(string stage, Exception error) { Log(stage + ": " + error); }
    string Key() {
        if(ownerKey != null)return ownerKey;
        var encrypted=Convert.FromBase64String(File.ReadAllText(Path.Combine(data,"secrets.dpapi")));
        var json=Encoding.UTF8.GetString(ProtectedData.Unprotect(encrypted,null,DataProtectionScope.CurrentUser));
        var fields=new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string,string>>(json);
        ownerKey=fields["owner"];return ownerKey;
    }
    void OpenDashboard() {
        try {
            Log("Open dashboard requested; ready=" + ready + ", opened=" + opened + ".");
            if(!ready) { tray.ShowBalloonTip(2000,"Setu","Starting your local inbox...",ToolTipIcon.Info); return; }
            if(window != null && !window.IsDisposed) {
                window.Show();if(window.WindowState==FormWindowState.Minimized)window.WindowState=FormWindowState.Normal;window.Activate();return;
            }
            window = new Form {
                Text="Setu", Size=new Size(1250,900), MinimumSize=new Size(700,560),
                StartPosition=FormStartPosition.CenterScreen, Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath),
                BackColor=Color.FromArgb(7,7,7), ForeColor=Color.FromArgb(255,241,229), AutoScaleMode=AutoScaleMode.Dpi,
                ShowInTaskbar=true, TopMost=false
            };
            var loading=new Label {Text="Opening your inbox...",Dock=DockStyle.Fill,TextAlign=ContentAlignment.MiddleCenter,Font=new Font("Segoe UI",14)};
            window.Controls.Add(loading);
            window.HandleCreated += (s,e) => ApplyTheme(true);
            window.FormClosed += (s,e) => {if(!stopping)ExitThread();};
            window.Shown += async (s,e) => {
                Log("Setu window shown; initializing WebView2.");
                try {
                    webView=new WebView2 {Dock=DockStyle.Fill,DefaultBackgroundColor=Color.FromArgb(7,7,7)};
                    window.Controls.Add(webView);webView.BringToFront();
                    string browserVersion=null;
                    try { browserVersion=CoreWebView2Environment.GetAvailableBrowserVersionString(); } catch(Exception versionError) { LogException("WebView2 runtime version lookup failed",versionError); }
                    Log("WebView2 runtime=" + (browserVersion ?? "not available") + "; user data=" + Path.Combine(data,"WebView2") + ".");
                    var environment=await CoreWebView2Environment.CreateAsync(null,Path.Combine(data,"WebView2"));
                    Log("WebView2 environment created.");
                    await webView.EnsureCoreWebView2Async(environment);
                    Log("WebView2 controller created.");
                    webView.CoreWebView2.Settings.AreDevToolsEnabled=false;
                    webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled=false;
                    webView.CoreWebView2.Settings.IsStatusBarEnabled=false;
                    webView.CoreWebView2.Settings.IsPasswordAutosaveEnabled=false;
                    webView.CoreWebView2.Settings.IsGeneralAutofillEnabled=false;
                    webView.CoreWebView2.PermissionRequested += (sender,permission) => permission.State=CoreWebView2PermissionState.Deny;
                    webView.CoreWebView2.NavigationStarting += (sender,navigation) => {
                        Uri uri;
                        if(!Uri.TryCreate(navigation.Uri,UriKind.Absolute,out uri)){navigation.Cancel=true;return;}
                        if(uri.GetLeftPart(UriPartial.Authority)==Origin)return;
                        navigation.Cancel=true;
                    };
                    webView.CoreWebView2.NewWindowRequested += (sender,popup) => popup.Handled=true;
                    webView.CoreWebView2.WebMessageReceived += (sender,message) => {
                        if(!message.Source.StartsWith(Origin+"/",StringComparison.Ordinal))return;
                        string text;try{text=message.TryGetWebMessageAsString();}catch{return;}
                        if(text.StartsWith("harbor-open-url:")) {
                            try { var target=new Uri(text.Substring("harbor-open-url:".Length)); if(target.Scheme!="https" && target.Scheme!="http")return; Process.Start(new ProcessStartInfo(target.AbsoluteUri){UseShellExecute=true}); }
                            catch { }
                            return;
                        }
                        if(text.StartsWith("harbor-file:")) {
                            try {
                                var parts=text.Split(':');
                                if(parts.Length!=3 || (parts[1]!="open" && parts[1]!="reveal") || !System.Text.RegularExpressions.Regex.IsMatch(parts[2],"^[a-zA-Z0-9_-]+$"))return;
                                Request("/api/login",new JavaScriptSerializer().Serialize(new {key=Key()}));
                                var result=new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string,string>>(Request("/api/files/"+parts[2]+"/location","{}"));
                                var saved=result["path"];
                                if(!Path.IsPathRooted(saved) || !File.Exists(saved))throw new IOException("The saved file is no longer available.");
                                var ext=Path.GetExtension(saved).ToLowerInvariant();
                                var previewable="|.jpg|.jpeg|.png|.gif|.webp|.heic|.bmp|.tif|.tiff|.mp4|.mov|.mkv|.webm|.avi|.mp3|.wav|.flac|.m4a|.pdf|.txt|";
                                if(parts[1]=="open" && previewable.Contains("|"+ext+"|"))Process.Start(new ProcessStartInfo(saved){UseShellExecute=true});
                                else Process.Start(new ProcessStartInfo("explorer.exe","/select,\""+saved+"\""){UseShellExecute=true});
                            }catch(Exception error){MessageBox.Show(window,"Could not open the saved file. It may have been moved or deleted.\n\n"+error.Message,"Setu",MessageBoxButtons.OK,MessageBoxIcon.Information);}
                        }
                        if(text=="harbor-theme:dark" || text=="harbor-theme:light")ApplyTheme(text=="harbor-theme:dark");
                        if(text=="harbor-ready" && !desktopRendered) {
                            desktopRendered=true;Log("Dedicated desktop window rendered and owner dashboard unlocked.");
                        }
                    };
                    webView.CoreWebView2.NavigationCompleted += (sender,navigation) => {
                        if(!navigation.IsSuccess)Log("Desktop navigation failed: "+navigation.WebErrorStatus);
                    };
                    webView.Source=new Uri(Origin+"/#key="+Uri.EscapeDataString(Key()));
                    loading.Dispose();
                    Log("WebView2 navigation started.");
                } catch(Exception error) {
                    LogException("Desktop window initialization failed",error);
                    loading.Text="Setu is running, but its embedded window could not be initialized.\r\n\r\n"+error.Message+"\r\n\r\nOpen Setu in your regular browser to continue.";
                    loading.ForeColor=Color.FromArgb(255,241,229);
                    loading.BackColor=Color.FromArgb(7,7,7);
                    tray.ShowBalloonTip(5000,"Setu","The embedded view failed. Setu is still available in your regular browser.",ToolTipIcon.Warning);
                    try { Process.Start(new ProcessStartInfo(Origin+"/#key="+Uri.EscapeDataString(Key())){UseShellExecute=true}); } catch(Exception browserError) { LogException("Browser fallback failed",browserError); }
                }
            };
            window.Show();window.Activate();window.BringToFront();
            Log("Setu window shown to user.");
        } catch(Exception error) {
            LogException("Dashboard window creation failed",error);
            try { tray.ShowBalloonTip(5000,"Setu","The dashboard window could not be created. Check desktop.log for details.",ToolTipIcon.Error); } catch { }
        }
    }
    string Request(string route,string json) {
        var req=(HttpWebRequest)WebRequest.Create(Origin+route);
        req.Proxy=null;req.Method="POST";req.Timeout=4000;req.CookieContainer=cookies;
        req.Headers["Origin"]=Origin;req.ContentType="application/json";
        var bytes=Encoding.UTF8.GetBytes(json);req.ContentLength=bytes.Length;
        using(var output=req.GetRequestStream())output.Write(bytes,0,bytes.Length);
        using(var response=req.GetResponse())using(var reader=new StreamReader(response.GetResponseStream()))return reader.ReadToEnd();
    }
    void Post(string route,string json) {
        if(!ready)throw new InvalidOperationException("Setu is still starting.");
        Request("/api/login", new JavaScriptSerializer().Serialize(new { key=Key() }));
        Request(route,json);
    }
    protected override void ExitThreadCore() {
        if(stopping)return;stopping=true;timer.Stop();tray.Visible=false;
        try { if(!server.HasExited) { try {Post("/api/shutdown","{}");}catch{} if(!server.WaitForExit(6500))server.Kill(); } } catch{}
        if(webView!=null)webView.Dispose();if(window!=null&&!window.IsDisposed)window.Dispose();
        tray.Dispose();timer.Dispose();server.Dispose();openSignal.Dispose();base.ExitThreadCore();
    }
}
