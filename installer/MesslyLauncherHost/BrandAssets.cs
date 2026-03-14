using System.IO;
using System.Linq;
using System.Reflection;

internal static class BrandAssets
{
  private const string ShortcutIconResourceSuffix = ".Assets.messly.ico";

  public static void EnsureInstalled(InstallPaths paths, LineLogger logger)
  {
    try
    {
      if (File.Exists(paths.ShortcutIconPath) && new FileInfo(paths.ShortcutIconPath).Length > 0)
      {
        return;
      }

      using var iconStream = ResolveShortcutIconStream();
      if (iconStream == null)
      {
        logger.Warn("Bundled shortcut icon resource not found.");
        return;
      }

      Directory.CreateDirectory(paths.RootDir);
      using var output = new FileStream(
        paths.ShortcutIconPath,
        FileMode.Create,
        FileAccess.Write,
        FileShare.Read
      );
      iconStream.CopyTo(output);
      logger.Info($"Shortcut icon installed to {paths.ShortcutIconPath}.");
    }
    catch (Exception error)
    {
      logger.Warn($"Failed to install shortcut icon: {error.Message}");
    }
  }

  private static Stream? ResolveShortcutIconStream()
  {
    var assembly = Assembly.GetExecutingAssembly();
    var resourceName = assembly.GetManifestResourceNames()
      .FirstOrDefault((name) =>
        name.EndsWith(ShortcutIconResourceSuffix, StringComparison.OrdinalIgnoreCase)
      );
    if (string.IsNullOrWhiteSpace(resourceName))
    {
      return null;
    }

    return assembly.GetManifestResourceStream(resourceName);
  }
}
