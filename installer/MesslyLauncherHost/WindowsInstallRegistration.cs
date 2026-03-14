using System.IO;
using System.Text.Json;
using Microsoft.Win32;

internal static class WindowsInstallRegistration
{
  private const string UninstallKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Messly";
  private const string DisplayName = "Messly";
  private const string Publisher = "Mackstony Labs";

  public static void Register(InstallPaths paths, LineLogger logger)
  {
    try
    {
      using var key = Registry.CurrentUser.CreateSubKey(UninstallKeyPath, writable: true);
      if (key == null)
      {
        logger.Warn("Failed to open uninstall registry key for write.");
        return;
      }

      var displayVersion = ResolveDisplayVersion(paths);
      var displayIcon = ResolveDisplayIcon(paths);
      var uninstallCommand = BuildUninstallCommand(paths);
      var estimatedSizeKb = EstimateInstallSizeKb(paths);

      key.SetValue("DisplayName", DisplayName, RegistryValueKind.String);
      key.SetValue("Publisher", Publisher, RegistryValueKind.String);
      key.SetValue("DisplayVersion", displayVersion, RegistryValueKind.String);
      key.SetValue("InstallLocation", paths.RootDir, RegistryValueKind.String);
      key.SetValue("DisplayIcon", $"{displayIcon},0", RegistryValueKind.String);
      key.SetValue("UninstallString", uninstallCommand, RegistryValueKind.String);
      key.SetValue("QuietUninstallString", $"{uninstallCommand} --silent", RegistryValueKind.String);
      key.SetValue("NoModify", 1, RegistryValueKind.DWord);
      key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
      key.SetValue("EstimatedSize", estimatedSizeKb, RegistryValueKind.DWord);
      key.SetValue("URLInfoAbout", "https://messly.site", RegistryValueKind.String);

      logger.Info("Windows uninstall registry entry refreshed.");
    }
    catch (Exception error)
    {
      logger.Warn($"Failed to refresh uninstall registry entry: {error.Message}");
    }
  }

  public static void Unregister(LineLogger logger)
  {
    try
    {
      Registry.CurrentUser.DeleteSubKeyTree(UninstallKeyPath, throwOnMissingSubKey: false);
      logger.Info("Windows uninstall registry entry removed.");
    }
    catch (Exception error)
    {
      logger.Warn($"Failed to remove uninstall registry entry: {error.Message}");
    }
  }

  public static string BuildUninstallCommand(InstallPaths paths)
  {
    return $"\"{paths.LauncherExecutablePath}\" --uninstall";
  }

  private static string ResolveDisplayIcon(InstallPaths paths)
  {
    if (File.Exists(paths.ShortcutIconPath))
    {
      return paths.ShortcutIconPath;
    }
    if (File.Exists(paths.LauncherExecutablePath))
    {
      return paths.LauncherExecutablePath;
    }
    if (File.Exists(paths.BrandedRuntimeExecutablePath))
    {
      return paths.BrandedRuntimeExecutablePath;
    }
    if (File.Exists(paths.RawRuntimeExecutablePath))
    {
      return paths.RawRuntimeExecutablePath;
    }
    return paths.RootDir;
  }

  private static string ResolveDisplayVersion(InstallPaths paths)
  {
    var candidates = new[] { paths.AppVersionPath, paths.RuntimeVersionPath };
    foreach (var metadataPath in candidates)
    {
      var version = TryReadVersion(metadataPath);
      if (!string.IsNullOrWhiteSpace(version))
      {
        return version;
      }
    }
    return "0.0.0";
  }

  private static string? TryReadVersion(string metadataPath)
  {
    try
    {
      if (!File.Exists(metadataPath))
      {
        return null;
      }

      var json = File.ReadAllText(metadataPath);
      using var document = JsonDocument.Parse(json);
      if (
        document.RootElement.TryGetProperty("version", out var versionProperty)
        && versionProperty.ValueKind == JsonValueKind.String
      )
      {
        var value = versionProperty.GetString();
        if (!string.IsNullOrWhiteSpace(value))
        {
          return value.Trim();
        }
      }
    }
    catch
    {
    }

    return null;
  }

  private static int EstimateInstallSizeKb(InstallPaths paths)
  {
    try
    {
      long totalBytes = 0;
      foreach (var root in EnumerateSizeDirectories(paths))
      {
        if (!Directory.Exists(root))
        {
          continue;
        }

        var stack = new Stack<string>();
        stack.Push(root);
        while (stack.Count > 0)
        {
          var current = stack.Pop();
          foreach (var directory in Directory.EnumerateDirectories(current))
          {
            stack.Push(directory);
          }
          foreach (var file in Directory.EnumerateFiles(current))
          {
            try
            {
              totalBytes += new FileInfo(file).Length;
            }
            catch
            {
            }
          }
        }
      }

      foreach (var filePath in EnumerateSizeFiles(paths))
      {
        try
        {
          if (File.Exists(filePath))
          {
            totalBytes += new FileInfo(filePath).Length;
          }
        }
        catch
        {
        }
      }

      var kilobytes = totalBytes / 1024;
      if (kilobytes <= 0)
      {
        return 0;
      }
      return (int)Math.Clamp(kilobytes, 0, int.MaxValue);
    }
    catch
    {
      return 0;
    }
  }

  private static IEnumerable<string> EnumerateSizeDirectories(InstallPaths paths)
  {
    yield return paths.RuntimeDir;
    yield return paths.AppDir;
  }

  private static IEnumerable<string> EnumerateSizeFiles(InstallPaths paths)
  {
    yield return paths.LauncherExecutablePath;
    yield return paths.ShortcutIconPath;
    yield return paths.ConfigPath;
  }
}
