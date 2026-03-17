const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_APP_MANIFEST_URL = "https://github.com/1blayze/Messly-updates/releases/latest/download/app-manifest.json";
const DEFAULT_SETUP_URL = "https://github.com/1blayze/Messly-updates/releases/latest/download/MesslySetup.exe";
const DEFAULT_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_NETWORK_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 700;
const DEFAULT_RETRY_MAX_DELAY_MS = 4_500;

function safeString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function parseSemver(versionRaw) {
  const normalized = safeString(versionRaw);
  if (!normalized) {
    return null;
  }
  const match = normalized.match(/^v?(\d+)\.(\d+)\.(\d+)$/i);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(aRaw, bRaw) {
  const a = parseSemver(aRaw);
  const b = parseSemver(bRaw);
  if (!a || !b) {
    return 0;
  }
  if (a[0] !== b[0]) {
    return a[0] - b[0];
  }
  if (a[1] !== b[1]) {
    return a[1] - b[1];
  }
  return a[2] - b[2];
}

function waitForTimeout(delayMs) {
  const safeDelay = Number.isFinite(delayMs) ? Math.max(0, Math.trunc(delayMs)) : 0;
  if (safeDelay <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, safeDelay);
  });
}

function readBooleanFlag(rawValue, fallbackValue = false) {
  const normalized = String(rawValue ?? "").trim().toLowerCase();
  if (!normalized) {
    return fallbackValue;
  }
  return !["0", "false", "off", "no"].includes(normalized);
}

function toSafeFileName(fileNameRaw, fallback) {
  const fileName = safeString(fileNameRaw);
  if (!fileName) {
    return fallback;
  }
  return fileName.replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "_");
}

function resolveLocalAppDataPath(app) {
  const envLocalAppData = safeString(process.env.LOCALAPPDATA);
  if (envLocalAppData) {
    return envLocalAppData;
  }
  try {
    const appDataPath = safeString(app?.getPath?.("appData"));
    if (!appDataPath) {
      return null;
    }
    // appData on Windows points to Roaming; launcher lives in LocalAppData.
    return path.resolve(appDataPath, "..", "Local");
  } catch {
    return null;
  }
}

function resolveLauncherExecutablePath(app) {
  const localAppDataPath = resolveLocalAppDataPath(app);
  const envLauncherPath = safeString(process.env.MESSLY_LAUNCHER_PATH);
  const candidates = [
    envLauncherPath,
    path.resolve(path.dirname(process.execPath), "..", "MesslyLauncher.exe"),
    localAppDataPath ? path.join(localAppDataPath, "Messly", "MesslyLauncher.exe") : null,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Ignore invalid paths.
    }
  }
  return null;
}

function resolveManifestUrl() {
  return (
    safeString(process.env.MESSLY_APP_MANIFEST_URL) ||
    safeString(process.env.MESSLY_RELEASE_APP_MANIFEST_URL) ||
    DEFAULT_APP_MANIFEST_URL
  );
}

function resolveSetupUrl() {
  return (
    safeString(process.env.MESSLY_SETUP_URL) ||
    safeString(process.env.MESSLY_RELEASE_SETUP_URL) ||
    DEFAULT_SETUP_URL
  );
}

function resolveRequestTimeoutMs() {
  const raw = Number(process.env.MESSLY_UPDATER_REQUEST_TIMEOUT_MS ?? DEFAULT_REQUEST_TIMEOUT_MS);
  if (!Number.isFinite(raw)) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  return Math.max(2_000, Math.min(60_000, Math.trunc(raw)));
}

function resolveNetworkRetryCount() {
  const raw = Number(process.env.MESSLY_UPDATER_NETWORK_RETRIES ?? DEFAULT_NETWORK_MAX_RETRIES);
  if (!Number.isFinite(raw)) {
    return DEFAULT_NETWORK_MAX_RETRIES;
  }
  return Math.max(1, Math.min(8, Math.trunc(raw)));
}

function resolveRetryBaseDelayMs() {
  const raw = Number(process.env.MESSLY_UPDATER_RETRY_BASE_DELAY_MS ?? DEFAULT_RETRY_BASE_DELAY_MS);
  if (!Number.isFinite(raw)) {
    return DEFAULT_RETRY_BASE_DELAY_MS;
  }
  return Math.max(150, Math.min(10_000, Math.trunc(raw)));
}

function resolveRetryMaxDelayMs() {
  const raw = Number(process.env.MESSLY_UPDATER_RETRY_MAX_DELAY_MS ?? DEFAULT_RETRY_MAX_DELAY_MS);
  if (!Number.isFinite(raw)) {
    return DEFAULT_RETRY_MAX_DELAY_MS;
  }
  return Math.max(500, Math.min(30_000, Math.trunc(raw)));
}

function calculateRetryDelayMs(attemptIndex, baseDelayMs, maxDelayMs) {
  const candidate = Number(baseDelayMs) * (2 ** Math.max(0, Number(attemptIndex) || 0));
  if (!Number.isFinite(candidate)) {
    return Math.max(250, Number(baseDelayMs) || DEFAULT_RETRY_BASE_DELAY_MS);
  }
  return Math.max(250, Math.min(Number(maxDelayMs) || DEFAULT_RETRY_MAX_DELAY_MS, Math.trunc(candidate)));
}

function getErrorMessage(error) {
  return safeString(error instanceof Error ? error.message : String(error ?? "")) ?? "Failed to update.";
}

function looksLikeTransientNetworkError(error) {
  const message = getErrorMessage(error).toLowerCase();
  if (!message) {
    return false;
  }
  return (
    message.includes("fetch failed")
    || message.includes("network")
    || message.includes("timeout")
    || message.includes("aborted")
    || message.includes("socket")
    || message.includes("ecconn")
    || message.includes("enotfound")
    || message.includes("eai_again")
    || message.includes("http 5")
    || message.includes("http 429")
  );
}

async function runWithRetry(task, options = {}) {
  const maxAttempts = Math.max(1, Math.trunc(Number(options.maxAttempts ?? DEFAULT_NETWORK_MAX_RETRIES)));
  const baseDelayMs = Math.max(100, Math.trunc(Number(options.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS)));
  const maxDelayMs = Math.max(250, Math.trunc(Number(options.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS)));
  const shouldRetry = typeof options.shouldRetry === "function"
    ? options.shouldRetry
    : () => true;
  const onRetry = typeof options.onRetry === "function" ? options.onRetry : null;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt >= maxAttempts;
      if (isLastAttempt || !shouldRetry(error, attempt)) {
        throw error;
      }
      const delayMs = calculateRetryDelayMs(attempt - 1, baseDelayMs, maxDelayMs);
      if (onRetry) {
        onRetry({
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts,
          delayMs,
          message: getErrorMessage(error),
        });
      }
      await waitForTimeout(delayMs);
    }
  }

  throw lastError ?? new Error("Unknown retry failure.");
}

function normalizeUrlFileName(urlRaw, fallbackName) {
  try {
    const parsed = new URL(urlRaw);
    const fromPath = safeString(path.basename(parsed.pathname));
    if (fromPath) {
      return toSafeFileName(fromPath, fallbackName);
    }
  } catch {
    // Ignore URL parsing errors.
  }
  return toSafeFileName(path.basename(String(urlRaw ?? "")), fallbackName);
}

function normalizeHashSha256(rawHash) {
  const normalized = safeString(rawHash);
  if (!normalized) {
    return null;
  }
  const stripped = normalized.replace(/^sha256:/i, "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(stripped)) {
    return null;
  }
  return stripped;
}

function parseManifestPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid update manifest payload.");
  }

  const version = safeString(payload.version);
  const releasedAt = safeString(payload.releasedAt) || safeString(payload.publishedAt);
  const packageUrl =
    safeString(payload?.package?.url) ||
    safeString(payload.download) ||
    safeString(payload.url);
  const packageName =
    safeString(payload?.package?.name) ||
    (packageUrl ? normalizeUrlFileName(packageUrl, "app.zip") : null);
  const packageSizeRaw =
    Number(payload?.package?.size ?? payload.size ?? 0);
  const packageSize = Number.isFinite(packageSizeRaw) && packageSizeRaw > 0
    ? Math.trunc(packageSizeRaw)
    : 0;
  const packageSha256 =
    normalizeHashSha256(payload?.package?.sha256) ||
    normalizeHashSha256(payload.sha256);
  const setupUrl = safeString(payload?.setup?.url);
  const setupName = safeString(payload?.setup?.name);
  const releaseNotes = safeString(payload.releaseNotes) || safeString(payload.notes);

  return {
    version,
    releasedAt,
    package: packageUrl
      ? {
          url: packageUrl,
          name: packageName,
          size: packageSize,
          sha256: packageSha256,
        }
      : null,
    setup: setupUrl
      ? {
          url: setupUrl,
          name: setupName || normalizeUrlFileName(setupUrl, "MesslySetup.exe"),
        }
      : null,
    releaseNotes,
  };
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while fetching ${url}.`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("end", () => {
      resolve(hash.digest("hex").toLowerCase());
    });
  });
}

async function downloadFileWithProgress(url, outputPath, timeoutMs, onProgress) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const tmpPath = `${outputPath}.download`;
  let writer = null;
  let writerDonePromise = null;

  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while downloading ${url}.`);
    }

    const totalBytes = Number(response.headers.get("content-length") ?? 0) || 0;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    if (fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath);
    }

    writer = fs.createWriteStream(tmpPath);
    writerDonePromise = new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    let downloadedBytes = 0;
    const body = response.body;
    if (!body || typeof body.getReader !== "function") {
      const buffer = Buffer.from(await response.arrayBuffer());
      downloadedBytes = buffer.length;
      writer.end(buffer);
      if (typeof onProgress === "function") {
        onProgress(downloadedBytes, totalBytes);
      }
    } else {
      const reader = body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        const value = chunk.value;
        if (!value || value.length === 0) {
          continue;
        }
        downloadedBytes += value.length;
        writer.write(Buffer.from(value));
        if (typeof onProgress === "function") {
          onProgress(downloadedBytes, totalBytes);
        }
      }
      writer.end();
    }

    if (writerDonePromise) {
      await writerDonePromise;
    }

    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
    fs.renameSync(tmpPath, outputPath);

    return {
      downloadedBytes,
      totalBytes,
    };
  } catch (error) {
    try {
      if (writer && !writer.closed) {
        writer.destroy();
      }
    } catch {}
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {}
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function escapePowerShellSingleQuoted(value) {
  return String(value ?? "").replace(/'/g, "''");
}

function createReleaseManifestUpdaterAdapter({ app, shell, managedByExternalLauncher = false }) {
  const manifestUrl = resolveManifestUrl();
  const setupUrlFallback = resolveSetupUrl();
  const requestTimeoutMs = resolveRequestTimeoutMs();
  const maxNetworkRetries = resolveNetworkRetryCount();
  const retryBaseDelayMs = resolveRetryBaseDelayMs();
  const retryMaxDelayMs = resolveRetryMaxDelayMs();
  const launcherManagedMode = Boolean(managedByExternalLauncher);
  const launcherExecutablePath = resolveLauncherExecutablePath(app);
  const updatesDir = path.join(app.getPath("userData"), "updates");
  const updateLogPath = path.join(app.getPath("userData"), "logs", "update.log");

  const state = {
    enabled: true,
    status: "idle",
    currentVersion: String(app.getVersion?.() ?? "0.0.0"),
    latestVersion: null,
    releaseName: null,
    publishedAt: null,
    releaseNotes: null,
    assetName: null,
    downloadedBytes: 0,
    totalBytes: 0,
    bytesPerSecond: 0,
    progressPercent: 0,
    lastCheckedAt: null,
    errorMessage: null,
  };

  let broadcast = () => {};
  let autoCheckTimer = null;
  let checkPromise = null;
  let downloadPromise = null;
  let installPromise = null;
  let latestManifest = null;
  let latestDownloadedFilePath = "";
  let latestDownloadMode = launcherManagedMode && launcherExecutablePath ? "launcher" : "setup";

  const appendUpdateLog = (message, metadata) => {
    try {
      fs.mkdirSync(path.dirname(updateLogPath), { recursive: true });
      const timestamp = new Date().toISOString();
      const details = metadata && typeof metadata === "object"
        ? ` ${JSON.stringify(metadata)}`
        : "";
      fs.appendFileSync(updateLogPath, `[${timestamp}] ${message}${details}\n`, "utf8");
    } catch {
      // Ignore logging failures.
    }
  };

  appendUpdateLog("Updater initialized", {
    currentVersion: state.currentVersion,
    manifestUrl,
    launcherManagedMode,
    launcherPath: launcherExecutablePath || null,
  });

  const emit = () => {
    try {
      broadcast({ ...state });
    } catch {
      // Ignore renderer notification errors.
    }
  };

  const setState = (patch) => {
    Object.assign(state, patch);
    emit();
  };

  const setUnavailableState = () => {
    setState({
      status: "unavailable",
      latestVersion: null,
      releaseName: null,
      publishedAt: null,
      releaseNotes: null,
      assetName: null,
      downloadedBytes: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
      progressPercent: 0,
      errorMessage: null,
      lastCheckedAt: new Date().toISOString(),
    });
  };

  function resolveDownloadTarget() {
    const manifestSetupUrl = safeString(latestManifest?.setup?.url);
    const manifestSetupName = safeString(latestManifest?.setup?.name);
    const manifestPackageUrl = safeString(latestManifest?.package?.url);
    const manifestPackageName = safeString(latestManifest?.package?.name);
    const selectedUrl = manifestSetupUrl || setupUrlFallback || manifestPackageUrl;
    if (!selectedUrl) {
      return null;
    }

    const fallbackName = manifestSetupUrl ? "MesslySetup.exe" : "app.zip";
    const selectedName = toSafeFileName(
      manifestSetupName || manifestPackageName || normalizeUrlFileName(selectedUrl, fallbackName),
      fallbackName,
    );

    const setupSha256 = normalizeHashSha256(latestManifest?.setup?.sha256);
    const packageSha256 = normalizeHashSha256(latestManifest?.package?.sha256);
    const expectedSha256 = setupSha256 || packageSha256 || null;
    const expectedSize = Number(
      latestManifest?.setup?.size
        ?? latestManifest?.package?.size
        ?? 0,
    );

    return {
      url: selectedUrl,
      name: selectedName,
      expectedSha256,
      expectedSize: Number.isFinite(expectedSize) && expectedSize > 0 ? Math.trunc(expectedSize) : 0,
    };
  }

  async function checkForUpdates() {
    if (checkPromise) {
      return checkPromise;
    }

    checkPromise = (async () => {
      try {
        appendUpdateLog("Checking update manifest", { manifestUrl });
        setState({
          status: "checking",
          errorMessage: null,
          lastCheckedAt: new Date().toISOString(),
        });

        const payload = await runWithRetry(
          async () => fetchJsonWithTimeout(manifestUrl, requestTimeoutMs),
          {
            maxAttempts: maxNetworkRetries,
            baseDelayMs: retryBaseDelayMs,
            maxDelayMs: retryMaxDelayMs,
            shouldRetry: (error) => looksLikeTransientNetworkError(error),
            onRetry: (info) => {
              appendUpdateLog("Manifest fetch retry scheduled", info);
            },
          },
        );

        const manifest = parseManifestPayload(payload);
        latestManifest = manifest;
        const latestVersion = safeString(manifest.version);
        const publishedAt = safeString(manifest.releasedAt);
        const packageName = safeString(manifest?.package?.name);
        const releaseName = latestVersion ? `Messly ${latestVersion}` : null;

        state.latestVersion = latestVersion;
        state.publishedAt = publishedAt;
        state.releaseName = releaseName;
        state.assetName = packageName;
        state.releaseNotes = safeString(manifest.releaseNotes);

        if (!latestVersion || compareSemver(latestVersion, state.currentVersion) <= 0) {
          appendUpdateLog("No update available", {
            currentVersion: state.currentVersion,
            latestVersion: latestVersion || null,
          });
          setUnavailableState();
          return { ...state };
        }

        appendUpdateLog("Update available", {
          currentVersion: state.currentVersion,
          latestVersion,
        });

        setState({
          status: "available",
          errorMessage: null,
          progressPercent: 0,
          downloadedBytes: 0,
          totalBytes: 0,
          bytesPerSecond: 0,
          lastCheckedAt: new Date().toISOString(),
        });
        return { ...state };
      } catch (error) {
        const message = getErrorMessage(error);
        appendUpdateLog("Update check failed", { message });
        setState({
          status: "error",
          errorMessage: message,
          lastCheckedAt: new Date().toISOString(),
        });
        throw new Error(message);
      } finally {
        checkPromise = null;
      }
    })();

    return checkPromise;
  }

  async function downloadUpdate() {
    if (downloadPromise) {
      return downloadPromise;
    }

    downloadPromise = (async () => {
      const currentStatus = String(state.status ?? "").trim().toLowerCase();
      if (currentStatus !== "available" && currentStatus !== "downloading" && currentStatus !== "downloaded" && currentStatus !== "ready") {
        await checkForUpdates();
      }

      const latestStatus = String(state.status ?? "").trim().toLowerCase();
      if (latestStatus !== "available" && latestStatus !== "downloading" && latestStatus !== "downloaded" && latestStatus !== "ready") {
        throw new Error("No update available for download.");
      }

      if (launcherManagedMode && launcherExecutablePath && fs.existsSync(launcherExecutablePath)) {
        latestDownloadedFilePath = launcherExecutablePath;
        latestDownloadMode = "launcher";
        setState({
          status: "downloaded",
          errorMessage: null,
          progressPercent: 100,
          downloadedBytes: 0,
          totalBytes: 0,
          bytesPerSecond: 0,
          assetName: path.basename(launcherExecutablePath),
        });
        appendUpdateLog("Launcher mode selected; using external launcher binary", {
          launcherPath: launcherExecutablePath,
        });
        return {
          state: { ...state },
          filePath: latestDownloadedFilePath,
        };
      }

      const target = resolveDownloadTarget();
      if (!target || !target.url) {
        throw new Error("Setup URL is unavailable.");
      }

      const setupOutputPath = path.join(updatesDir, target.name);
      const startedAt = Date.now();

      appendUpdateLog("Downloading update payload", {
        url: target.url,
        outputPath: setupOutputPath,
        expectedSize: target.expectedSize || null,
        expectedSha256: target.expectedSha256 || null,
      });

      setState({
        status: "downloading",
        errorMessage: null,
        progressPercent: 0,
        downloadedBytes: 0,
        totalBytes: target.expectedSize || 0,
        bytesPerSecond: 0,
        assetName: target.name,
      });

      await runWithRetry(
        async () => downloadFileWithProgress(
          target.url,
          setupOutputPath,
          Math.max(requestTimeoutMs, 120_000),
          (downloadedBytes, totalBytes) => {
            const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
            const progressPercent = totalBytes > 0
              ? Math.max(0, Math.min(100, (downloadedBytes / totalBytes) * 100))
              : 0;
            const bytesPerSecond = Math.max(0, Math.round(downloadedBytes / elapsedSeconds));
            setState({
              status: "downloading",
              downloadedBytes,
              totalBytes: totalBytes || state.totalBytes,
              progressPercent,
              bytesPerSecond,
              errorMessage: null,
            });
          },
        ),
        {
          maxAttempts: maxNetworkRetries,
          baseDelayMs: retryBaseDelayMs,
          maxDelayMs: retryMaxDelayMs,
          shouldRetry: (error) => looksLikeTransientNetworkError(error),
          onRetry: (info) => {
            appendUpdateLog("Download retry scheduled", info);
            setState({
              status: "retrying",
              errorMessage: `Retrying download (${info.nextAttempt}/${info.maxAttempts})...`,
              bytesPerSecond: 0,
            });
          },
        },
      );

      if (target.expectedSha256) {
        const actualSha = await sha256File(setupOutputPath);
        if (actualSha !== target.expectedSha256) {
          try {
            fs.unlinkSync(setupOutputPath);
          } catch {}
          appendUpdateLog("Downloaded payload hash mismatch", {
            expected: target.expectedSha256,
            actual: actualSha,
          });
          throw new Error("Downloaded package failed integrity verification (SHA256 mismatch).");
        }
      }

      latestDownloadedFilePath = setupOutputPath;
      latestDownloadMode = "setup";
      appendUpdateLog("Update payload downloaded successfully", {
        filePath: latestDownloadedFilePath,
      });

      setState({
        status: "downloaded",
        errorMessage: null,
        progressPercent: 100,
        downloadedBytes: state.totalBytes || state.downloadedBytes,
        bytesPerSecond: 0,
      });

      return {
        state: { ...state },
        filePath: latestDownloadedFilePath,
      };
    })().finally(() => {
      downloadPromise = null;
    });

    return downloadPromise;
  }

  async function launchExternalLauncherAndQuit(launcherPath) {
    if (!launcherPath || !fs.existsSync(launcherPath)) {
      throw new Error("Launcher executable not found.");
    }

    appendUpdateLog("Launching external C# updater", {
      launcherPath,
      args: ["--launcher"],
    });

    if (process.platform === "win32") {
      const currentPid = process.pid;
      const launcherPathPs = escapePowerShellSingleQuoted(launcherPath);
      const command = [
        `while (Get-Process -Id ${currentPid} -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 250 }`,
        `Start-Process -FilePath '${launcherPathPs}' -ArgumentList '--launcher'`,
      ].join("; ");
      const child = spawn("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-Command",
        command,
      ], {
        cwd: path.dirname(launcherPath),
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "",
        },
      });
      child.unref();
      appendUpdateLog("Scheduled launcher start after runtime process exit", {
        pid: currentPid,
      });
    } else {
      const child = spawn(launcherPath, ["--launcher"], {
        cwd: path.dirname(launcherPath),
        detached: true,
        stdio: "ignore",
        windowsHide: false,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "",
        },
      });
      child.unref();
    }

    setState({
      status: "relaunching",
      errorMessage: null,
      progressPercent: 100,
    });

    setTimeout(() => {
      try {
        app.quit();
      } catch {
        // Ignore quit errors.
      }
    }, 120);
  }

  async function installUpdate() {
    if (installPromise) {
      return installPromise;
    }

    installPromise = (async () => {
      const status = String(state.status ?? "").trim().toLowerCase();
      if (status !== "downloaded" && status !== "ready" && status !== "available") {
        await checkForUpdates();
      }

      const statusAfterCheck = String(state.status ?? "").trim().toLowerCase();
      if (statusAfterCheck !== "downloaded" && statusAfterCheck !== "ready" && statusAfterCheck !== "available") {
        throw new Error("No update ready to install.");
      }

      setState({
        status: "installing",
        errorMessage: null,
        progressPercent: 100,
        bytesPerSecond: 0,
      });

      if (launcherManagedMode && launcherExecutablePath && fs.existsSync(launcherExecutablePath)) {
        await launchExternalLauncherAndQuit(launcherExecutablePath);
        return {
          launched: true,
        };
      }

      if (statusAfterCheck === "available") {
        await downloadUpdate();
      }

      const launchMode = latestDownloadMode;
      const launchPath = latestDownloadedFilePath;

      if (launchMode === "launcher") {
        await launchExternalLauncherAndQuit(launchPath);
        return {
          launched: true,
        };
      }

      if (!launchPath || !fs.existsSync(launchPath)) {
        appendUpdateLog("Local setup file missing. Falling back to setup URL.", {
          setupUrlFallback,
        });
        const opened = await shell.openExternal(setupUrlFallback);
        if (!opened) {
          throw new Error("Failed to start setup update.");
        }
      } else {
        appendUpdateLog("Launching downloaded setup package", {
          filePath: launchPath,
        });
        const child = spawn(launchPath, [], {
          cwd: path.dirname(launchPath),
          detached: true,
          stdio: "ignore",
          windowsHide: false,
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "",
          },
        });
        child.unref();
      }

      setState({
        status: "relaunching",
        errorMessage: null,
        progressPercent: 100,
      });

      setTimeout(() => {
        try {
          app.quit();
        } catch {
          // Ignore quit errors.
        }
      }, 140);

      return {
        launched: true,
      };
    })().finally(() => {
      installPromise = null;
    });

    return installPromise;
  }

  function startAutoCheck(intervalMs, options = {}) {
    if (autoCheckTimer) {
      clearInterval(autoCheckTimer);
      autoCheckTimer = null;
    }
    const skipInitialCheck = Boolean(options?.skipInitialCheck);
    if (!skipInitialCheck) {
      void checkForUpdates().catch((error) => {
        appendUpdateLog("Initial auto-check failed", { message: getErrorMessage(error) });
      });
    }
    const rawInterval = Number(intervalMs);
    const delayMs = Number.isFinite(rawInterval) && rawInterval >= 60_000
      ? Math.trunc(rawInterval)
      : DEFAULT_CHECK_INTERVAL_MS;
    autoCheckTimer = setInterval(() => {
      void checkForUpdates().catch((error) => {
        appendUpdateLog("Scheduled auto-check failed", { message: getErrorMessage(error) });
      });
    }, delayMs);
  }

  function stopAutoCheck() {
    if (autoCheckTimer) {
      clearInterval(autoCheckTimer);
      autoCheckTimer = null;
    }
  }

  return {
    getState: () => ({ ...state }),
    setBroadcaster(nextBroadcaster) {
      broadcast = typeof nextBroadcaster === "function" ? nextBroadcaster : () => {};
      emit();
    },
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    startAutoCheck,
    stopAutoCheck,
  };
}

module.exports = {
  createReleaseManifestUpdaterAdapter,
};
