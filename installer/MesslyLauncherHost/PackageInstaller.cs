using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

internal enum ComponentKind
{
  Runtime,
  App,
}

internal sealed class PackageInstaller
{
  private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
  {
    PropertyNameCaseInsensitive = true,
    ReadCommentHandling = JsonCommentHandling.Skip,
    AllowTrailingCommas = true,
    WriteIndented = true,
  };

  private readonly InstallPaths _paths;
  private readonly LauncherConfig _config;
  private readonly LineLogger _logger;
  private readonly IInstallerProgressSink? _progressSink;
  private readonly HttpClient _httpClient;

  public PackageInstaller(
    InstallPaths paths,
    LauncherConfig config,
    LineLogger logger,
    IInstallerProgressSink? progressSink
  )
  {
    _paths = paths;
    _config = config;
    _logger = logger;
    _progressSink = progressSink;
    _httpClient = new HttpClient
    {
      Timeout = TimeSpan.FromSeconds(Math.Clamp(config.RequestTimeoutSeconds, 8, 90)),
    };
    _httpClient.DefaultRequestHeaders.UserAgent.Add(
      new ProductInfoHeaderValue("MesslyLauncher", "1.0.0")
    );
  }

  public async Task EnsureComponentAsync(ComponentKind kind, bool required, bool allowUpdate)
  {
    var local = ReadLocalMetadata(kind, _paths);
    var componentState = BuildComponentState(kind, local);
    var missing = !componentState.HasRequiredFiles;
    if (!missing)
    {
      _logger.Info($"{componentState.DisplayName} local version={componentState.Version ?? "unknown"}.");
    }

    PackageManifest? manifest = null;
    if (allowUpdate || missing)
    {
      try
      {
        manifest = await FetchManifestAsync(componentState.ManifestUrl);
      }
      catch (Exception error)
      {
        if (required && missing)
        {
          throw new InvalidOperationException(
            $"Unable to download {componentState.DisplayName} manifest from {componentState.ManifestUrl}: {error.Message}",
            error
          );
        }
        _logger.Warn(
          $"{componentState.DisplayName} manifest unavailable. Keeping installed version. {error.Message}"
        );
      }
    }

    if (manifest == null)
    {
      if (required && missing)
      {
        throw new InvalidOperationException(
          $"Cannot continue: {componentState.DisplayName} is missing and manifest download failed."
        );
      }
      return;
    }

    ValidateManifest(manifest, componentState);

    var shouldInstall = missing || ShouldUpdate(
      componentState.Version,
      manifest.Version,
      componentState.PackageSha256,
      manifest.Package!.Sha256
    );
    if (!shouldInstall)
    {
      _logger.Info($"{componentState.DisplayName} already up to date ({componentState.Version}).");
      CleanupDownloadedArchives(componentState.DisplayName, archivePathToKeep: null);
      return;
    }

    _logger.Info($"{componentState.DisplayName} update detected {componentState.Version ?? "none"} -> {manifest.Version}.");
    await InstallFromManifestAsync(componentState, manifest);
  }

  private ComponentState BuildComponentState(ComponentKind kind, LocalComponentMetadata? local)
  {
    return kind switch
    {
      ComponentKind.Runtime => new ComponentState(
        kind,
        "runtime",
        _config.RuntimeManifestUrl,
        _paths.RuntimeDir,
        _paths.RuntimeVersionPath,
        local?.Version,
        local?.PackageSha256,
        HasRuntimeFiles(_paths.RuntimeDir)
      ),
      ComponentKind.App => new ComponentState(
        kind,
        "app",
        _config.AppManifestUrl,
        _paths.AppDir,
        _paths.AppVersionPath,
        local?.Version,
        local?.PackageSha256,
        HasAppFiles(_paths.AppDir)
      ),
      _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unsupported component kind."),
    };
  }

  private async Task<PackageManifest> FetchManifestAsync(string manifestUrl)
  {
    if (string.IsNullOrWhiteSpace(manifestUrl))
    {
      throw new InvalidOperationException("Manifest URL is empty.");
    }

    _logger.Info($"Downloading manifest: {manifestUrl}");
    using var response = await _httpClient.GetAsync(manifestUrl);
    response.EnsureSuccessStatusCode();
    var json = await response.Content.ReadAsStringAsync();
    var parsed = JsonSerializer.Deserialize<PackageManifest>(json, JsonOptions);
    return parsed ?? throw new InvalidOperationException("Invalid manifest payload.");
  }

  private static void ValidateManifest(PackageManifest manifest, ComponentState componentState)
  {
    if (string.IsNullOrWhiteSpace(manifest.Version))
    {
      throw new InvalidOperationException($"Manifest for {componentState.DisplayName} has empty version.");
    }
    if (manifest.Package == null)
    {
      throw new InvalidOperationException($"Manifest for {componentState.DisplayName} is missing package block.");
    }
    if (string.IsNullOrWhiteSpace(manifest.Package.Url))
    {
      throw new InvalidOperationException($"Manifest for {componentState.DisplayName} has empty package URL.");
    }
    if (string.IsNullOrWhiteSpace(manifest.Package.Sha256))
    {
      throw new InvalidOperationException($"Manifest for {componentState.DisplayName} has empty package sha256.");
    }
  }

  private async Task InstallFromManifestAsync(ComponentState state, PackageManifest manifest)
  {
    var safeVersion = SanitizeForPath(manifest.Version);
    var archivePath = Path.Combine(_paths.UpdatesDir, $"{state.DisplayName}-{safeVersion}.zip");
    Directory.CreateDirectory(_paths.UpdatesDir);

    if (!File.Exists(archivePath) || !await VerifyArchiveHashAsync(archivePath, manifest.Package!.Sha256))
    {
      ReportStatus(GetDownloadStatusMessage(state), null, true);
      await DownloadArchiveAsync(
        manifest.Package!.Url,
        archivePath,
        (downloadedBytes, totalBytes) =>
        {
          ReportByteProgress(
            GetDownloadStatusMessage(state),
            downloadedBytes,
            totalBytes,
            manifest.Package!.Size
          );
        }
      );
    }

    if (!await VerifyArchiveHashAsync(archivePath, manifest.Package!.Sha256))
    {
      throw new InvalidOperationException($"Hash mismatch after download for {state.DisplayName} package.");
    }

    var stagingPath = Path.Combine(_paths.StagingDir, $"{state.DisplayName}-{Guid.NewGuid():N}");
    Directory.CreateDirectory(_paths.StagingDir);
    if (Directory.Exists(stagingPath))
    {
      Directory.Delete(stagingPath, recursive: true);
    }
    Directory.CreateDirectory(stagingPath);

    var extractionStatusMessage = GetExtractionStatusMessage(state);
    _logger.Info($"Extracting {state.DisplayName} package.");
    ReportStatus(extractionStatusMessage, null, true);
    await ExtractArchiveWithProgressAsync(
      archivePath,
      stagingPath,
      (extractedBytes, totalBytes) =>
      {
        ReportByteProgress(extractionStatusMessage, extractedBytes, totalBytes, fallbackTotalBytes: 0);
      }
    );

    ValidateExtractedPayload(stagingPath, state, manifest.EntryPoint);
    ReplaceDirectory(stagingPath, state.InstallDirectory);
    SaveLocalMetadata(state.VersionPath, manifest, archivePath);
    CleanupDownloadedArchives(state.DisplayName, archivePathToKeep: null);
    ReportStatus(extractionStatusMessage, 1, false);
    _logger.Info($"{state.DisplayName} installed successfully at {state.InstallDirectory}.");
  }

  private async Task DownloadArchiveAsync(
    string archiveUrl,
    string archivePath,
    Action<long, long>? progressCallback
  )
  {
    _logger.Info($"Downloading package: {archiveUrl}");
    using var response = await _httpClient.GetAsync(archiveUrl, HttpCompletionOption.ResponseHeadersRead);
    response.EnsureSuccessStatusCode();
    var contentLength = response.Content.Headers.ContentLength ?? 0;
    await using var responseStream = await response.Content.ReadAsStreamAsync();
    await using var outputStream = new FileStream(archivePath, FileMode.Create, FileAccess.Write, FileShare.None);
    var buffer = new byte[128 * 1024];
    long totalRead = 0;

    while (true)
    {
      var bytesRead = await responseStream.ReadAsync(buffer.AsMemory(0, buffer.Length));
      if (bytesRead <= 0)
      {
        break;
      }
      await outputStream.WriteAsync(buffer.AsMemory(0, bytesRead));
      totalRead += bytesRead;
      progressCallback?.Invoke(totalRead, contentLength);
    }

    progressCallback?.Invoke(totalRead, contentLength);
  }

  private static async Task ExtractArchiveWithProgressAsync(
    string archivePath,
    string destinationDirectory,
    Action<long, long>? progressCallback
  )
  {
    using var archive = ZipFile.OpenRead(archivePath);
    var destinationRoot = Path.GetFullPath(destinationDirectory);
    long totalBytes = archive.Entries
      .Where((entry) => !string.IsNullOrEmpty(entry.Name))
      .Sum((entry) => Math.Max(0, entry.Length));
    long extractedBytes = 0;
    var buffer = new byte[128 * 1024];

    foreach (var entry in archive.Entries)
    {
      var destinationPath = Path.GetFullPath(Path.Combine(destinationRoot, entry.FullName));
      if (!destinationPath.StartsWith(destinationRoot, StringComparison.OrdinalIgnoreCase))
      {
        throw new InvalidOperationException($"Zip entry path traversal blocked: {entry.FullName}");
      }

      if (string.IsNullOrEmpty(entry.Name))
      {
        Directory.CreateDirectory(destinationPath);
        continue;
      }

      var destinationParent = Path.GetDirectoryName(destinationPath);
      if (!string.IsNullOrWhiteSpace(destinationParent))
      {
        Directory.CreateDirectory(destinationParent);
      }

      await using var entryStream = entry.Open();
      await using var outputStream = new FileStream(destinationPath, FileMode.Create, FileAccess.Write, FileShare.None);

      while (true)
      {
        var bytesRead = await entryStream.ReadAsync(buffer.AsMemory(0, buffer.Length));
        if (bytesRead <= 0)
        {
          break;
        }
        await outputStream.WriteAsync(buffer.AsMemory(0, bytesRead));
        extractedBytes += bytesRead;
        progressCallback?.Invoke(extractedBytes, totalBytes);
      }

      try
      {
        File.SetLastWriteTime(destinationPath, entry.LastWriteTime.DateTime);
      }
      catch
      {
      }
    }

    progressCallback?.Invoke(totalBytes, totalBytes);
  }

  private static async Task<bool> VerifyArchiveHashAsync(string archivePath, string expectedSha256)
  {
    if (!File.Exists(archivePath))
    {
      return false;
    }

    var normalizedExpected = NormalizeSha256(expectedSha256);
    if (string.IsNullOrEmpty(normalizedExpected))
    {
      return false;
    }

    await using var stream = File.OpenRead(archivePath);
    using var sha = SHA256.Create();
    var hash = await sha.ComputeHashAsync(stream);
    var normalizedActual = Convert.ToHexString(hash).ToLowerInvariant();
    return string.Equals(normalizedActual, normalizedExpected, StringComparison.OrdinalIgnoreCase);
  }

  private static string NormalizeSha256(string raw)
  {
    var normalized = (raw ?? string.Empty).Trim().ToLowerInvariant();
    if (normalized.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase))
    {
      normalized = normalized["sha256:".Length..];
    }
    return normalized;
  }

  private static void ValidateExtractedPayload(string stagingPath, ComponentState state, string? manifestEntryPoint)
  {
    if (state.Kind == ComponentKind.Runtime)
    {
      var runtimeEntryCandidates = new List<string>();
      if (!string.IsNullOrWhiteSpace(manifestEntryPoint))
      {
        runtimeEntryCandidates.Add(manifestEntryPoint.Trim());
      }
      runtimeEntryCandidates.Add("Messly.exe");
      runtimeEntryCandidates.Add("electron.exe");
      foreach (var candidate in runtimeEntryCandidates.Distinct(StringComparer.OrdinalIgnoreCase))
      {
        if (File.Exists(Path.Combine(stagingPath, candidate)))
        {
          return;
        }
      }
      throw new InvalidOperationException("Runtime package is missing executable entry point.");
    }

    if (state.Kind == ComponentKind.App)
    {
      var appEntry = string.IsNullOrWhiteSpace(manifestEntryPoint)
        ? "app.asar"
        : manifestEntryPoint.Trim();
      if (!File.Exists(Path.Combine(stagingPath, appEntry)) && !File.Exists(Path.Combine(stagingPath, "app.asar")))
      {
        throw new InvalidOperationException("App package is missing app.asar.");
      }
    }
  }

  private static void ReplaceDirectory(string sourceDirectory, string targetDirectory)
  {
    var backupDirectory = targetDirectory + ".backup";
    if (Directory.Exists(backupDirectory))
    {
      Directory.Delete(backupDirectory, recursive: true);
    }
    if (Directory.Exists(targetDirectory))
    {
      Directory.Move(targetDirectory, backupDirectory);
    }
    Directory.Move(sourceDirectory, targetDirectory);
    if (Directory.Exists(backupDirectory))
    {
      try
      {
        Directory.Delete(backupDirectory, recursive: true);
      }
      catch
      {
      }
    }
  }

  private static bool ShouldUpdate(
    string? installedVersion,
    string latestVersion,
    string? installedPackageSha256,
    string latestPackageSha256
  )
  {
    if (string.IsNullOrWhiteSpace(installedVersion))
    {
      return true;
    }

    if (Version.TryParse(installedVersion, out var installed) && Version.TryParse(latestVersion, out var latest))
    {
      if (latest > installed)
      {
        return true;
      }
      if (latest < installed)
      {
        return false;
      }
      return ShouldUpdateByPackageHash(installedPackageSha256, latestPackageSha256);
    }

    var installedNormalized = installedVersion.Trim();
    var latestNormalized = latestVersion.Trim();
    if (!string.Equals(installedNormalized, latestNormalized, StringComparison.OrdinalIgnoreCase))
    {
      return true;
    }
    return ShouldUpdateByPackageHash(installedPackageSha256, latestPackageSha256);
  }

  private static bool ShouldUpdateByPackageHash(string? installedPackageSha256, string latestPackageSha256)
  {
    var latestNormalized = NormalizeSha256(latestPackageSha256);
    if (string.IsNullOrWhiteSpace(latestNormalized))
    {
      return false;
    }

    var installedNormalized = NormalizeSha256(installedPackageSha256 ?? string.Empty);
    if (string.IsNullOrWhiteSpace(installedNormalized))
    {
      return true;
    }

    return !string.Equals(installedNormalized, latestNormalized, StringComparison.OrdinalIgnoreCase);
  }

  private static string SanitizeForPath(string input)
  {
    var invalid = Path.GetInvalidFileNameChars();
    var sb = new StringBuilder(input.Length);
    foreach (var ch in input)
    {
      sb.Append(invalid.Contains(ch) ? '-' : ch);
    }
    return sb.ToString();
  }

  private void CleanupDownloadedArchives(string componentDisplayName, string? archivePathToKeep)
  {
    try
    {
      if (!Directory.Exists(_paths.UpdatesDir))
      {
        return;
      }

      var prefix = $"{componentDisplayName}-";
      foreach (var archivePath in Directory.EnumerateFiles(_paths.UpdatesDir, "*.zip", SearchOption.TopDirectoryOnly))
      {
        var fileName = Path.GetFileName(archivePath);
        if (!fileName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
          continue;
        }
        if (!string.IsNullOrWhiteSpace(archivePathToKeep)
          && string.Equals(
            Path.GetFullPath(archivePath),
            Path.GetFullPath(archivePathToKeep),
            StringComparison.OrdinalIgnoreCase
          ))
        {
          continue;
        }

        try
        {
          File.Delete(archivePath);
        }
        catch
        {
        }
      }
    }
    catch
    {
    }
  }

  private static bool HasRuntimeFiles(string runtimeDirectory)
  {
    var branded = Path.Combine(runtimeDirectory, "Messly.exe");
    var raw = Path.Combine(runtimeDirectory, "electron.exe");
    return File.Exists(branded) || File.Exists(raw);
  }

  private static bool HasAppFiles(string appDirectory)
  {
    return File.Exists(Path.Combine(appDirectory, "app.asar"));
  }

  private static LocalComponentMetadata? ReadLocalMetadata(ComponentKind kind, InstallPaths paths)
  {
    var versionPath = kind == ComponentKind.Runtime ? paths.RuntimeVersionPath : paths.AppVersionPath;
    return ReadLocalMetadata(versionPath);
  }

  private static LocalComponentMetadata? ReadLocalMetadata(string versionPath)
  {
    try
    {
      if (!File.Exists(versionPath))
      {
        return null;
      }
      var raw = File.ReadAllText(versionPath, Encoding.UTF8);
      var parsed = JsonSerializer.Deserialize<LocalComponentMetadata>(raw, JsonOptions);
      return parsed;
    }
    catch
    {
      return null;
    }
  }

  private static void SaveLocalMetadata(string versionPath, PackageManifest manifest, string archivePath)
  {
    var metadata = new LocalComponentMetadata
    {
      Version = manifest.Version,
      InstalledAtIso = DateTimeOffset.UtcNow.ToString("O"),
      PackageName = manifest.Package?.Name ?? Path.GetFileName(archivePath),
      PackageSha256 = NormalizeSha256(manifest.Package?.Sha256 ?? string.Empty),
    };
    var json = JsonSerializer.Serialize(metadata, JsonOptions);
    Directory.CreateDirectory(Path.GetDirectoryName(versionPath) ?? ".");
    File.WriteAllText(versionPath, json + Environment.NewLine, Encoding.UTF8);
  }

  private static string GetDownloadStatusMessage(ComponentState state)
  {
    return state.Kind == ComponentKind.Runtime
      ? "Downloading runtime"
      : "Downloading application";
  }

  private static string GetExtractionStatusMessage(ComponentState state)
  {
    return state.Kind == ComponentKind.Runtime
      ? "Extracting runtime"
      : "Installing application";
  }

  private void ReportStatus(string message, double? progressFraction, bool isIndeterminate)
  {
    _progressSink?.Report(new InstallerProgressState(message, progressFraction, isIndeterminate));
  }

  private void ReportByteProgress(string message, long completedBytes, long totalBytes, long fallbackTotalBytes)
  {
    var effectiveTotal = totalBytes > 0 ? totalBytes : Math.Max(0, fallbackTotalBytes);
    if (effectiveTotal <= 0)
    {
      ReportStatus(message, null, true);
      return;
    }

    var normalizedProgress = Math.Clamp((double)completedBytes / effectiveTotal, 0, 1);
    ReportStatus(message, normalizedProgress, false);
  }

  private readonly record struct ComponentState(
    ComponentKind Kind,
    string DisplayName,
    string ManifestUrl,
    string InstallDirectory,
    string VersionPath,
    string? Version,
    string? PackageSha256,
    bool HasRequiredFiles
  );
}

internal sealed class PackageManifest
{
  [JsonPropertyName("kind")]
  public string Kind { get; set; } = "";

  [JsonPropertyName("version")]
  public string Version { get; set; } = "";

  [JsonPropertyName("releasedAt")]
  public string ReleasedAt { get; set; } = "";

  [JsonPropertyName("entryPoint")]
  public string? EntryPoint { get; set; }

  [JsonPropertyName("package")]
  public PackageDescriptor? Package { get; set; }
}

internal sealed class PackageDescriptor
{
  [JsonPropertyName("name")]
  public string Name { get; set; } = "";

  [JsonPropertyName("url")]
  public string Url { get; set; } = "";

  [JsonPropertyName("sha256")]
  public string Sha256 { get; set; } = "";

  [JsonPropertyName("size")]
  public long Size { get; set; }
}

internal sealed class LocalComponentMetadata
{
  [JsonPropertyName("version")]
  public string Version { get; set; } = "";

  [JsonPropertyName("installedAt")]
  public string InstalledAtIso { get; set; } = "";

  [JsonPropertyName("packageName")]
  public string PackageName { get; set; } = "";

  [JsonPropertyName("packageSha256")]
  public string PackageSha256 { get; set; } = "";
}
