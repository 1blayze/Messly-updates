using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using static HostConstants;

internal sealed class HostOptions
{
  public bool IsLauncherMode { get; init; }
  public bool IsUninstallMode { get; init; }
  public bool IsSilentMode { get; init; }
  public bool NoLaunch { get; init; }
  public bool SkipShortcuts { get; init; }
  public string RuntimeManifestUrl { get; init; } = "";
  public string AppManifestUrl { get; init; } = "";
  public IReadOnlyList<string> ForwardArguments { get; init; } = Array.Empty<string>();

  public static HostOptions Parse(IEnumerable<string> args)
  {
    bool isLauncherMode = false;
    bool isUninstallMode = false;
    bool isSilentMode = false;
    bool noLaunch = false;
    bool skipShortcuts = false;
    string runtimeManifestUrl = "";
    string appManifestUrl = "";
    var forwardArguments = new List<string>();
    var forwardAllRemaining = false;

    foreach (var raw in args)
    {
      var argument = (raw ?? string.Empty).Trim();
      if (forwardAllRemaining)
      {
        if (!string.IsNullOrWhiteSpace(argument))
        {
          forwardArguments.Add(argument);
        }
        continue;
      }
      if (argument == "--")
      {
        forwardAllRemaining = true;
        continue;
      }
      if (argument.Equals(HostModeArg, StringComparison.OrdinalIgnoreCase))
      {
        isLauncherMode = true;
      }
      else if (argument.Equals(UninstallArg, StringComparison.OrdinalIgnoreCase))
      {
        isUninstallMode = true;
      }
      else if (argument.Equals(SilentArg, StringComparison.OrdinalIgnoreCase))
      {
        isSilentMode = true;
      }
      else if (argument.Equals(NoLaunchArg, StringComparison.OrdinalIgnoreCase))
      {
        noLaunch = true;
      }
      else if (argument.Equals(SkipShortcutsArg, StringComparison.OrdinalIgnoreCase))
      {
        skipShortcuts = true;
      }
      else if (argument.StartsWith(RuntimeManifestArgPrefix, StringComparison.OrdinalIgnoreCase))
      {
        runtimeManifestUrl = argument[RuntimeManifestArgPrefix.Length..].Trim();
      }
      else if (argument.StartsWith(AppManifestArgPrefix, StringComparison.OrdinalIgnoreCase))
      {
        appManifestUrl = argument[AppManifestArgPrefix.Length..].Trim();
      }
      else if (!string.IsNullOrWhiteSpace(argument))
      {
        forwardArguments.Add(argument);
      }
    }

    return new HostOptions
    {
      IsLauncherMode = isLauncherMode,
      IsUninstallMode = isUninstallMode,
      IsSilentMode = isSilentMode,
      NoLaunch = noLaunch,
      SkipShortcuts = skipShortcuts,
      RuntimeManifestUrl = runtimeManifestUrl,
      AppManifestUrl = appManifestUrl,
      ForwardArguments = forwardArguments,
    };
  }
}

internal sealed class InstallPaths
{
  private InstallPaths(string rootDir)
  {
    RootDir = rootDir;
  }

  public string RootDir { get; }
  public string RuntimeDir => Path.Combine(RootDir, "runtime");
  public string AppDir => Path.Combine(RootDir, "app");
  public string UpdatesDir => Path.Combine(RootDir, "updates");
  public string StagingDir => Path.Combine(RootDir, ".staging");
  public string LogsDir => Path.Combine(RootDir, "logs");
  public string ConfigPath => Path.Combine(RootDir, "launcher-config.json");
  public string LogFilePath => Path.Combine(LogsDir, "launcher.log");
  public string LauncherExecutablePath => Path.Combine(RootDir, "MesslyLauncher.exe");
  public string ShortcutIconPath => Path.Combine(RootDir, "messly.ico");
  public string BrandedRuntimeExecutablePath => Path.Combine(RuntimeDir, "Messly.exe");
  public string RawRuntimeExecutablePath => Path.Combine(RuntimeDir, "electron.exe");
  public string AppAsarPath => Path.Combine(AppDir, "app.asar");
  public string RuntimeVersionPath => Path.Combine(RuntimeDir, ".version.json");
  public string AppVersionPath => Path.Combine(AppDir, ".version.json");

  public static InstallPaths CreateDefault()
  {
    var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    if (string.IsNullOrWhiteSpace(localAppData))
    {
      throw new InvalidOperationException("Unable to resolve LocalAppData path.");
    }
    return new InstallPaths(Path.Combine(localAppData, "Messly"));
  }
}

internal sealed class LauncherConfig
{
  [JsonPropertyName("runtimeManifestUrl")]
  public string RuntimeManifestUrl { get; set; } = DefaultRuntimeManifestUrl;

  [JsonPropertyName("appManifestUrl")]
  public string AppManifestUrl { get; set; } = DefaultAppManifestUrl;

  [JsonPropertyName("requestTimeoutSeconds")]
  public int RequestTimeoutSeconds { get; set; } = DefaultRequestTimeoutSeconds;

  [JsonPropertyName("createdAt")]
  public string CreatedAtIso { get; set; } = DateTimeOffset.UtcNow.ToString("O");

  public static LauncherConfig From(HostOptions options)
  {
    var runtimeFromEnv = Environment.GetEnvironmentVariable(RuntimeManifestUrlEnv);
    var appFromEnv = Environment.GetEnvironmentVariable(AppManifestUrlEnv);

    return new LauncherConfig
    {
      RuntimeManifestUrl = Coalesce(
        options.RuntimeManifestUrl,
        runtimeFromEnv,
        DefaultRuntimeManifestUrl
      ),
      AppManifestUrl = Coalesce(
        options.AppManifestUrl,
        appFromEnv,
        DefaultAppManifestUrl
      ),
      RequestTimeoutSeconds = DefaultRequestTimeoutSeconds,
      CreatedAtIso = DateTimeOffset.UtcNow.ToString("O"),
    };
  }

  private static string Coalesce(params string?[] values)
  {
    foreach (var value in values)
    {
      if (!string.IsNullOrWhiteSpace(value))
      {
        return value.Trim();
      }
    }
    return string.Empty;
  }
}

internal static class LauncherConfigStore
{
  private static readonly JsonSerializerOptions JsonOptions = CreateJsonOptions();

  public static LauncherConfig? Load(string configPath)
  {
    if (!File.Exists(configPath))
    {
      return null;
    }

    var json = File.ReadAllText(configPath, Encoding.UTF8);
    var parsed = JsonSerializer.Deserialize<LauncherConfig>(json, JsonOptions);
    return parsed;
  }

  public static void Save(string configPath, LauncherConfig config)
  {
    var json = JsonSerializer.Serialize(config, JsonOptions);
    Directory.CreateDirectory(Path.GetDirectoryName(configPath) ?? ".");
    File.WriteAllText(configPath, json + Environment.NewLine, Encoding.UTF8);
  }

  private static JsonSerializerOptions CreateJsonOptions()
  {
    return new JsonSerializerOptions(JsonSerializerDefaults.Web)
    {
      WriteIndented = true,
      PropertyNameCaseInsensitive = true,
      AllowTrailingCommas = true,
      ReadCommentHandling = JsonCommentHandling.Skip,
    };
  }
}
