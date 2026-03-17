using System.Diagnostics;
using System.Collections.Generic;
using System.IO;
using static HostConstants;

var options = HostOptions.Parse(args);
var installPaths = InstallPaths.CreateDefault();
var logger = new LineLogger(installPaths.LogFilePath);
using var mutex = new Mutex(false, MutexName);
using var activationEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ActivationEventName);
InstallerUiHost? installerUi = null;
RegisteredWaitHandle? activationWait = null;

if (!mutex.WaitOne(TimeSpan.FromSeconds(2), false))
{
  TrySignalRunningInstance(activationEvent);
  logger.Warn("Another launcher process is active; exiting.");
  return 0;
}

try
{
  var mode = options.IsUninstallMode
    ? "uninstall"
    : options.IsLauncherMode
      ? "launcher"
      : "bootstrap";
  logger.Info($"Host started. Mode={mode}.");
  Directory.CreateDirectory(installPaths.RootDir);
  Directory.CreateDirectory(installPaths.LogsDir);

  if (options.IsUninstallMode)
  {
    RunUninstallMode(installPaths, logger);
    return 0;
  }

  Directory.CreateDirectory(installPaths.UpdatesDir);
  Directory.CreateDirectory(installPaths.StagingDir);

  if (!options.IsLauncherMode)
  {
    if (!options.IsSilentMode)
    {
      installerUi = new InstallerUiHost();
      installerUi.Report(new InstallerProgressState("Installing Messly", null, true));
      activationWait = RegisterActivationListener(activationEvent, installerUi, logger);
    }
  }

  if (options.IsLauncherMode)
  {
    if (ShouldShowLauncherProgressUi(options, installPaths))
    {
      installerUi = new InstallerUiHost();
      installerUi.Report(new InstallerProgressState("Checking for updates", null, true));
      activationWait = RegisterActivationListener(activationEvent, installerUi, logger);
    }

    await RunLauncherModeAsync(options, installPaths, logger, installerUi);
  }
  else
  {
    await RunBootstrapModeAsync(options, installPaths, logger, installerUi);
  }

  return 0;
}
catch (Exception error)
{
  logger.Error($"Fatal error: {error.Message}");
  logger.Error(error.ToString());
  if (installerUi != null)
  {
    installerUi.ShowFailure("Installation failed");
    await Task.Delay(2500);
  }
  return 1;
}
finally
{
  activationWait?.Unregister(null);
  installerUi?.Dispose();
  logger.Dispose();
}

static bool ShouldShowLauncherProgressUi(HostOptions options, InstallPaths paths)
{
  if (options.IsSilentMode || options.NoLaunch)
  {
    return false;
  }

  var runtimeExecutablePath = TryResolveRuntimeExecutable(paths);
  if (runtimeExecutablePath != null && IsRuntimeRunning(runtimeExecutablePath))
  {
    return false;
  }

  return true;
}

static RegisteredWaitHandle? RegisterActivationListener(
  EventWaitHandle activationEvent,
  InstallerUiHost installerUi,
  LineLogger logger
)
{
  try
  {
    return ThreadPool.RegisterWaitForSingleObject(
      activationEvent,
      static (state, _) =>
      {
        if (state is InstallerUiHost uiHost)
        {
          uiHost.BringToFront();
        }
      },
      installerUi,
      Timeout.Infinite,
      executeOnlyOnce: false
    );
  }
  catch (Exception error)
  {
    logger.Warn($"Failed to register activation listener: {error.Message}");
    return null;
  }
}

static void TrySignalRunningInstance(EventWaitHandle activationEvent)
{
  try
  {
    activationEvent.Set();
  }
  catch
  {
  }
}

static async Task RunBootstrapModeAsync(
  HostOptions options,
  InstallPaths paths,
  LineLogger logger,
  IInstallerProgressSink? progressSink
)
{
  var config = LauncherConfig.From(options);
  LauncherConfigStore.Save(paths.ConfigPath, config);
  logger.Info($"Config saved at {paths.ConfigPath}.");

  SelfInstallLauncher(paths, logger);
  BrandAssets.EnsureInstalled(paths, logger);
  CreateShortcutsIfEnabled(options, paths, logger);
  EnsureRuntimeNotRunning(paths, logger);
  ResetStagingDirectory(paths);

  var installer = new PackageInstaller(paths, config, logger, progressSink);
  await installer.EnsureComponentAsync(ComponentKind.Runtime, required: true, allowUpdate: true);
  await installer.EnsureComponentAsync(ComponentKind.App, required: true, allowUpdate: true);
  WindowsInstallRegistration.Register(paths, logger);

  if (!options.NoLaunch)
  {
    progressSink?.Report(new InstallerProgressState("Starting Messly", 1, false));
    await Task.Delay(300);
    logger.Info("Starting runtime directly after bootstrap install.");
    LaunchInstalledRuntime(paths, options.ForwardArguments, logger);
  }
}

static async Task RunLauncherModeAsync(
  HostOptions options,
  InstallPaths paths,
  LineLogger logger,
  IInstallerProgressSink? progressSink
)
{
  var config = LauncherConfigStore.Load(paths.ConfigPath) ?? LauncherConfig.From(options);
  BrandAssets.EnsureInstalled(paths, logger);
  ResetStagingDirectory(paths);
  var installer = new PackageInstaller(paths, config, logger, progressSink);

  var runtimeExecutablePath = TryResolveRuntimeExecutable(paths);
  var appEntryPath = TryResolveAppEntry(paths);
  var runtimeRunning = runtimeExecutablePath != null && IsRuntimeRunning(runtimeExecutablePath);

  if (runtimeRunning)
  {
    logger.Info("Runtime is already running; skipping update check for this launch.");
  }
  else
  {
    await installer.EnsureComponentAsync(ComponentKind.Runtime, required: true, allowUpdate: true);
    await installer.EnsureComponentAsync(ComponentKind.App, required: true, allowUpdate: true);
    WindowsInstallRegistration.Register(paths, logger);
    runtimeExecutablePath = ResolveRuntimeExecutable(paths);
    appEntryPath = ResolveAppEntry(paths);
  }

  if (options.NoLaunch)
  {
    logger.Info("Launcher mode requested with --no-launch; update check completed.");
    return;
  }

  runtimeExecutablePath ??= ResolveRuntimeExecutable(paths);
  appEntryPath ??= ResolveAppEntry(paths);
  LaunchInstalledRuntime(paths, options.ForwardArguments, logger, runtimeExecutablePath, appEntryPath);
}

static void SelfInstallLauncher(InstallPaths paths, LineLogger logger)
{
  var currentExecutablePath = Environment.ProcessPath;
  if (string.IsNullOrWhiteSpace(currentExecutablePath) || !File.Exists(currentExecutablePath))
  {
    throw new InvalidOperationException("Unable to resolve current executable path.");
  }

  var normalizedCurrent = Path.GetFullPath(currentExecutablePath);
  var normalizedLauncher = Path.GetFullPath(paths.LauncherExecutablePath);
  if (string.Equals(normalizedCurrent, normalizedLauncher, StringComparison.OrdinalIgnoreCase))
  {
    logger.Info("Running from launcher path; self-install copy skipped.");
    return;
  }

  Directory.CreateDirectory(paths.RootDir);
  File.Copy(normalizedCurrent, normalizedLauncher, overwrite: true);
  logger.Info($"Launcher installed to {normalizedLauncher}.");
}

static void CreateShortcutsIfEnabled(HostOptions options, InstallPaths paths, LineLogger logger)
{
  if (options.SkipShortcuts)
  {
    logger.Info("Shortcut creation skipped by flag.");
    return;
  }

  try
  {
    ShortcutManager.EnsureShortcuts(paths, logger);
  }
  catch (Exception error)
  {
    logger.Warn($"Shortcut creation failed: {error.Message}");
  }
}

static void EnsureRuntimeNotRunning(InstallPaths paths, LineLogger logger)
{
  var stoppedBranded = TryStopProcessAtPath(paths.BrandedRuntimeExecutablePath);
  var stoppedRaw = TryStopProcessAtPath(paths.RawRuntimeExecutablePath);
  if (stoppedBranded || stoppedRaw)
  {
    logger.Info("Stopped running Messly runtime to perform update safely.");
    Thread.Sleep(250);
  }
}

static void RunUninstallMode(InstallPaths paths, LineLogger logger)
{
  logger.Info("Starting uninstall flow.");

  TryStopProcessAtPath(paths.BrandedRuntimeExecutablePath);
  TryStopProcessAtPath(paths.RawRuntimeExecutablePath);

  try
  {
    ShortcutManager.RemoveShortcuts(paths, logger);
  }
  catch (Exception error)
  {
    logger.Warn($"Failed to remove shortcuts: {error.Message}");
  }

  TryDeleteDirectory(paths.RuntimeDir);
  TryDeleteDirectory(paths.AppDir);
  TryDeleteDirectory(paths.UpdatesDir);
  TryDeleteDirectory(paths.StagingDir);
  TryDeleteFile(paths.ConfigPath);
  TryDeleteFile(paths.ShortcutIconPath);

  WindowsInstallRegistration.Unregister(logger);
  logger.Info("Uninstall flow finished.");
}

static bool IsRuntimeRunning(string runtimeExecutablePath)
{
  var executableNameWithoutExtension = Path.GetFileNameWithoutExtension(runtimeExecutablePath);
  if (string.IsNullOrWhiteSpace(executableNameWithoutExtension))
  {
    return false;
  }

  try
  {
    foreach (var process in Process.GetProcessesByName(executableNameWithoutExtension))
    {
      try
      {
        if (string.Equals(process.MainModule?.FileName, runtimeExecutablePath, StringComparison.OrdinalIgnoreCase))
        {
          return true;
        }
      }
      catch
      {
      }
      finally
      {
        process.Dispose();
      }
    }
  }
  catch
  {
    return false;
  }

  return false;
}

static string ResolveRuntimeExecutable(InstallPaths paths)
{
  var candidates = new[]
  {
    paths.BrandedRuntimeExecutablePath,
    paths.RawRuntimeExecutablePath,
  };

  foreach (var candidate in candidates)
  {
    if (File.Exists(candidate))
    {
      return candidate;
    }
  }

  throw new FileNotFoundException("Runtime executable not found in install directory.");
}

static string? TryResolveRuntimeExecutable(InstallPaths paths)
{
  try
  {
    return ResolveRuntimeExecutable(paths);
  }
  catch
  {
    return null;
  }
}

static string ResolveAppEntry(InstallPaths paths)
{
  if (File.Exists(paths.AppAsarPath))
  {
    return paths.AppAsarPath;
  }

  if (Directory.Exists(paths.AppDir))
  {
    return paths.AppDir;
  }

  throw new DirectoryNotFoundException("Application payload is missing.");
}

static string? TryResolveAppEntry(InstallPaths paths)
{
  try
  {
    return ResolveAppEntry(paths);
  }
  catch
  {
    return null;
  }
}

static void LaunchInstalledRuntime(
  InstallPaths paths,
  IReadOnlyList<string> forwardArguments,
  LineLogger logger,
  string? resolvedRuntimeExecutablePath = null,
  string? resolvedAppEntryPath = null
)
{
  var runtimeExecutablePath = resolvedRuntimeExecutablePath ?? ResolveRuntimeExecutable(paths);
  var appEntryPath = resolvedAppEntryPath ?? ResolveAppEntry(paths);
  var runtimeArgs = new List<string> { appEntryPath };
  runtimeArgs.AddRange(forwardArguments);

  var launchEnv = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
  {
    ["MESSLY_EXTERNAL_LAUNCHER"] = "1",
    ["AUTO_UPDATE_BLOCK_STARTUP"] = "0",
    ["AUTO_UPDATE_INSTALL_ON_STARTUP"] = "0",
  };
  logger.Info($"Launching runtime: {runtimeExecutablePath} {appEntryPath}");
  StartProcess(runtimeExecutablePath, runtimeArgs, paths.RootDir, launchEnv);
}

static void StartProcess(string fileName, IEnumerable<string> arguments, string workingDirectory, IReadOnlyDictionary<string, string>? env)
{
  var psi = new ProcessStartInfo
  {
    FileName = fileName,
    WorkingDirectory = workingDirectory,
    UseShellExecute = false,
    CreateNoWindow = true,
  };

  foreach (var argument in arguments)
  {
    psi.ArgumentList.Add(argument);
  }

  if (psi.Environment.ContainsKey("ELECTRON_RUN_AS_NODE"))
  {
    psi.Environment.Remove("ELECTRON_RUN_AS_NODE");
  }

  if (env != null)
  {
    foreach (var pair in env)
    {
      psi.Environment[pair.Key] = pair.Value;
    }
  }

  _ = Process.Start(psi) ?? throw new InvalidOperationException($"Failed to start process: {fileName}");
}

static bool TryStopProcessAtPath(string executablePath)
{
  if (string.IsNullOrWhiteSpace(executablePath) || !File.Exists(executablePath))
  {
    return false;
  }

  var processName = Path.GetFileNameWithoutExtension(executablePath);
  if (string.IsNullOrWhiteSpace(processName))
  {
    return false;
  }
  var stoppedAny = false;

  try
  {
    foreach (var process in Process.GetProcessesByName(processName))
    {
      try
      {
        var processPath = process.MainModule?.FileName;
        if (!string.Equals(processPath, executablePath, StringComparison.OrdinalIgnoreCase))
        {
          continue;
        }

        process.Kill(entireProcessTree: true);
        process.WaitForExit(3000);
        stoppedAny = true;
      }
      catch
      {
      }
      finally
      {
        process.Dispose();
      }
    }
  }
  catch
  {
  }

  return stoppedAny;
}

static void ResetStagingDirectory(InstallPaths paths)
{
  TryDeleteDirectory(paths.StagingDir);
  try
  {
    Directory.CreateDirectory(paths.StagingDir);
  }
  catch
  {
  }
}

static void TryDeleteDirectory(string directoryPath)
{
  try
  {
    if (Directory.Exists(directoryPath))
    {
      Directory.Delete(directoryPath, recursive: true);
    }
  }
  catch
  {
  }
}

static void TryDeleteFile(string filePath)
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
