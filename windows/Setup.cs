using System;

using System.Diagnostics;

using System.IO;

using System.IO.Compression;

using System.Reflection;

using System.Windows.Forms;

using Microsoft.Win32;



internal static class Setup {

    [STAThread] static int Main(string[] args) {

        bool quiet=Array.IndexOf(args,"--quiet")>=0, noLaunch=Array.IndexOf(args,"--no-launch")>=0;

        Application.EnableVisualStyles();

        try {

            string home=Path.GetFullPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Harbor"));

            string app=Path.Combine(home,"App");

            if(Directory.Exists(home)&&(File.GetAttributes(home)&FileAttributes.ReparsePoint)!=0)throw new IOException("The Setu installation root is a filesystem link.");

            if(!quiet && MessageBox.Show("Install Setu for your Windows account?\n\nIncludes the runtime and Cloudflare connector. No administrator access is needed. Your files and credentials stay on this PC.","Install Setu",MessageBoxButtons.OKCancel,MessageBoxIcon.Information)!=DialogResult.OK)return 0;

            if(Directory.Exists(app) && (File.GetAttributes(app)&FileAttributes.ReparsePoint)!=0)throw new IOException("The install folder is a filesystem link. Choose a normal local installation folder.");

            foreach(var proc in Process.GetProcessesByName("Harbor")) { try { if(proc.MainModule.FileName==Path.Combine(app,"Harbor.exe"))throw new IOException("Exit the previous Harbor process from its tray icon before installing Setu."); } catch(System.ComponentModel.Win32Exception){} }
            foreach(var proc in Process.GetProcessesByName("Setu")) { try { if(proc.MainModule.FileName==Path.Combine(app,"Setu.exe"))throw new IOException("Exit Setu from its tray icon before installing an update."); } catch(System.ComponentModel.Win32Exception){} }

            // Remove obsolete payload files when upgrading, while leaving the separate data directory untouched.
            foreach(string directory in new[]{"server","public"}) {
                string target=Path.Combine(app,directory);
                if(Directory.Exists(target))Directory.Delete(target,true);
            }

            Directory.CreateDirectory(app);

            using(var input=Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))

            using(var zip=new ZipArchive(input,ZipArchiveMode.Read)) {

                foreach(var entry in zip.Entries) {

                    string target=Path.GetFullPath(Path.Combine(app,entry.FullName.Replace('/',Path.DirectorySeparatorChar)));

                    if(!target.StartsWith(app+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new IOException("Invalid installer payload path.");

                    if(String.IsNullOrEmpty(entry.Name)){Directory.CreateDirectory(target);continue;}

                    string parent=Path.GetDirectoryName(target);

                    Directory.CreateDirectory(parent);

                    for(string check=parent;check.Length>=app.Length;check=Path.GetDirectoryName(check))

                        if((File.GetAttributes(check)&FileAttributes.ReparsePoint)!=0)throw new IOException("The install destination contains a filesystem link.");

                    if(File.Exists(target)&&(File.GetAttributes(target)&FileAttributes.ReparsePoint)!=0)throw new IOException("An install target is a filesystem link.");

                    using(var source=entry.Open())using(var dest=new FileStream(target,FileMode.Create,FileAccess.Write))source.CopyTo(dest);

                }

            }

            string desktop=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),"Setu.lnk");

            string menu=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),"Setu");Directory.CreateDirectory(menu);
            string legacyDesktop=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),"Harbor.lnk");if(File.Exists(legacyDesktop))File.Delete(legacyDesktop);
            string oldBrandDesktop=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),"Send Local Cloud.lnk");if(File.Exists(oldBrandDesktop))File.Delete(oldBrandDesktop);
            string legacyMenu=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),"Harbor");
            foreach(string name in new[]{"Harbor.lnk","Uninstall Harbor.lnk"})if(File.Exists(Path.Combine(legacyMenu,name)))File.Delete(Path.Combine(legacyMenu,name));
            if(Directory.Exists(legacyMenu)&&Directory.GetFileSystemEntries(legacyMenu).Length==0)Directory.Delete(legacyMenu);

            if(File.Exists(Path.Combine(app,"Harbor.exe")))File.Delete(Path.Combine(app,"Harbor.exe"));
            if(File.Exists(Path.Combine(app,"Uninstall Harbor.exe")))File.Delete(Path.Combine(app,"Uninstall Harbor.exe"));
            foreach(string name in new[]{"Send Local Cloud.lnk","Uninstall Send Local Cloud.lnk"})if(File.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),"Send Local Cloud",name)))File.Delete(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),"Send Local Cloud",name));

            Shortcut(desktop,Path.Combine(app,"Setu.exe"),app);

            Shortcut(Path.Combine(menu,"Setu.lnk"),Path.Combine(app,"Setu.exe"),app);

            Shortcut(Path.Combine(menu,"Uninstall Setu.lnk"),Path.Combine(app,"Uninstall Setu.exe"),app);

            using(var key=Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\Harbor")) {

                key.SetValue("DisplayName","Setu");key.SetValue("DisplayVersion","0.3.13");key.SetValue("Publisher","Setu (local build)");

                key.SetValue("InstallLocation",app);key.SetValue("DisplayIcon",Path.Combine(app,"Setu.exe"));

                key.SetValue("UninstallString","\""+Path.Combine(app,"Uninstall Setu.exe")+"\"");

                key.SetValue("NoModify",1);key.SetValue("NoRepair",1);

            }

            if(!noLaunch)Process.Start(new ProcessStartInfo(Path.Combine(app,"Setu.exe")){UseShellExecute=true});

            if(!quiet)MessageBox.Show("Setu is installed. Open its dedicated window from your desktop or Start menu. Use its tray icon to pause receiving or exit.\n\nYour dashboard unlocks automatically inside the app.","Setu installed");

            return 0;

        }catch(Exception e){if(!quiet)MessageBox.Show(e.Message,"Installation failed",MessageBoxButtons.OK,MessageBoxIcon.Error);try{File.WriteAllText(Path.Combine(Path.GetTempPath(),"setu-install-error.txt"),e.ToString());}catch{}return 1;}

    }

    static void Shortcut(string file,string target,string working) {

        dynamic shell=Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));

        dynamic link=shell.CreateShortcut(file);link.TargetPath=target;link.WorkingDirectory=working;link.IconLocation=target;link.Description="Setu local file transfer";link.Save();

    }

}

