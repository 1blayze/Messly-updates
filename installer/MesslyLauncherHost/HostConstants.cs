internal static class HostConstants
{
  public const string RuntimeManifestUrlEnv = "MESSLY_RUNTIME_MANIFEST_URL";
  public const string AppManifestUrlEnv = "MESSLY_APP_MANIFEST_URL";
  public const string DefaultRuntimeManifestUrl = "https://github.com/1blayze/Messly-updates/releases/latest/download/runtime-manifest.json";
  public const string DefaultAppManifestUrl = "https://github.com/1blayze/Messly-updates/releases/latest/download/app-manifest.json";
  public const int DefaultRequestTimeoutSeconds = 20;
  public const string HostModeArg = "--launcher";
  public const string NoLaunchArg = "--no-launch";
  public const string UninstallArg = "--uninstall";
  public const string SilentArg = "--silent";
  public const string SkipShortcutsArg = "--skip-shortcuts";
  public const string RuntimeManifestArgPrefix = "--runtime-manifest-url=";
  public const string AppManifestArgPrefix = "--app-manifest-url=";
  public const string LogPrefix = "[messly-host]";
  public const string MutexName = "Global\\MesslyLauncherHost";
}
