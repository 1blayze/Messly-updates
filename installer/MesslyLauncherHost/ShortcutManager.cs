using System;
using System.IO;
using System.Linq;
using System.Runtime.Versioning;
using static HostConstants;

internal static class ShortcutManager
{
  [SupportedOSPlatform("windows")]
  public static void EnsureShortcuts(InstallPaths paths, LineLogger logger)
  {
    var launcherPath = paths.LauncherExecutablePath;
    if (!File.Exists(launcherPath))
    {
      throw new FileNotFoundException("Launcher executable missing for shortcut creation.", launcherPath);
    }

    var iconPath = File.Exists(paths.ShortcutIconPath)
      ? paths.ShortcutIconPath
      : launcherPath;
    var startMenuProgramsPath = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
    var startMenuMesslyPath = Path.Combine(startMenuProgramsPath, "Messly");
    Directory.CreateDirectory(startMenuMesslyPath);

    var desktopShortcutPath = Path.Combine(
      Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
      "Messly.lnk"
    );
    var startMenuShortcutPath = Path.Combine(startMenuMesslyPath, "Messly.lnk");
    var args = HostModeArg;

    CreateShortcut(desktopShortcutPath, launcherPath, args, paths.RootDir, iconPath);
    CreateShortcut(startMenuShortcutPath, launcherPath, args, paths.RootDir, iconPath);
    logger.Info("Desktop and Start Menu shortcuts refreshed.");
  }

  [SupportedOSPlatform("windows")]
  public static void RemoveShortcuts(InstallPaths paths, LineLogger logger)
  {
    var desktopShortcutPath = Path.Combine(
      Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
      "Messly.lnk"
    );
    var startMenuProgramsPath = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
    var startMenuMesslyPath = Path.Combine(startMenuProgramsPath, "Messly");
    var startMenuShortcutPath = Path.Combine(startMenuMesslyPath, "Messly.lnk");

    TryDeleteFile(desktopShortcutPath);
    TryDeleteFile(startMenuShortcutPath);
    TryDeleteDirectoryIfEmpty(startMenuMesslyPath);

    logger.Info("Desktop and Start Menu shortcuts removed.");
  }

  [SupportedOSPlatform("windows")]
  private static void CreateShortcut(
    string shortcutPath,
    string targetPath,
    string args,
    string workingDirectory,
    string iconPath
  )
  {
    var shellType = Type.GetTypeFromProgID("WScript.Shell")
      ?? throw new InvalidOperationException("WScript.Shell COM object not available.");
    dynamic shell = Activator.CreateInstance(shellType)
      ?? throw new InvalidOperationException("Failed to instantiate WScript.Shell.");
    dynamic shortcut = shell.CreateShortcut(shortcutPath);
    shortcut.TargetPath = targetPath;
    shortcut.Arguments = args;
    shortcut.WorkingDirectory = workingDirectory;
    shortcut.IconLocation = $"{iconPath},0";
    shortcut.WindowStyle = 1;
    shortcut.Save();
  }

  private static void TryDeleteFile(string filePath)
  {
    try
    {
      if (File.Exists(filePath))
      {
        File.Delete(filePath);
      }
    }
    catch
    {
    }
  }

  private static void TryDeleteDirectoryIfEmpty(string directoryPath)
  {
    try
    {
      if (!Directory.Exists(directoryPath))
      {
        return;
      }
      if (Directory.EnumerateFileSystemEntries(directoryPath).Any())
      {
        return;
      }
      Directory.Delete(directoryPath, recursive: false);
    }
    catch
    {
    }
  }
}
