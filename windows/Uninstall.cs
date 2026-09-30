using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class Uninstall {
    [STAThread] static int Main(string[] args) {
        Application.EnableVisualStyles();
        if(MessageBox.Show("Remove Setu's program files and shortcuts?\n\nYour inbox, credentials and app data will be kept.","Uninstall Setu",MessageBoxButtons.OKCancel,MessageBoxIcon.Question)!=DialogResult.OK)return 0;
        try {
            string app=Path.GetFullPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Harbor","App"));
            foreach(var p in Process.GetProcessesByName("Harbor"))try{if(p.MainModule.FileName==Path.Combine(app,"Harbor.exe"))throw new IOException("Exit the previous Harbor process from its tray icon, then run uninstall again.");}catch(System.ComponentModel.Win32Exception){}
            foreach(var p in Process.GetProcessesByName("Setu"))try{if(p.MainModule.FileName==Path.Combine(app,"Setu.exe"))throw new IOException("Exit Setu from its tray icon, then run uninstall again.");}catch(System.ComponentModel.Win32Exception){}
            // Delete only known program contents. Keep this small running uninstaller and all user data.
            Clean(app,Path.GetFullPath(Application.ExecutablePath));
            string link=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),"Setu.lnk");if(File.Exists(link))File.Delete(link);
            string oldLink=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),"Send Local Cloud.lnk");if(File.Exists(oldLink))File.Delete(oldLink);
            string menu=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),"Setu");
            foreach(string name in new[]{"Setu.lnk","Uninstall Setu.lnk"})if(File.Exists(Path.Combine(menu,name)))File.Delete(Path.Combine(menu,name));
            if(Directory.Exists(menu)&&Directory.GetFileSystemEntries(menu).Length==0)Directory.Delete(menu);
            string oldMenu=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),"Send Local Cloud");
            foreach(string name in new[]{"Send Local Cloud.lnk","Uninstall Send Local Cloud.lnk"})if(File.Exists(Path.Combine(oldMenu,name)))File.Delete(Path.Combine(oldMenu,name));
            if(Directory.Exists(oldMenu)&&Directory.GetFileSystemEntries(oldMenu).Length==0)Directory.Delete(oldMenu);
            Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\Harbor",false);
            MessageBox.Show("Setu was removed. Your files and data were kept. This small uninstaller remains in the program folder and can be deleted after closing this window.","Setu removed");return 0;
        }catch(Exception e){MessageBox.Show(e.Message,"Could not remove Setu");return 1;}
    }
    static void Clean(string root,string keep) {
        if((File.GetAttributes(root)&FileAttributes.ReparsePoint)!=0)throw new IOException("Refusing to traverse a linked program folder.");
        foreach(var item in Directory.GetFileSystemEntries(root)) {
            string full=Path.GetFullPath(item);if(!full.StartsWith(Path.GetFullPath(root)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new IOException("Invalid program path.");
            if(full.Equals(keep,StringComparison.OrdinalIgnoreCase))continue;
            var attributes=File.GetAttributes(full);
            if((attributes&FileAttributes.ReparsePoint)!=0)throw new IOException("Remove filesystem links from the app folder before uninstalling.");
            if((attributes&FileAttributes.Directory)!=0){Clean(full,keep);Directory.Delete(full);}else File.Delete(full);
        }
    }
}
