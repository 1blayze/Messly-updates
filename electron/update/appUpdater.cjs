const fs = require("node:fs");
const fsp = fs.promises;
const https = require("node:https");
const path = require("node:path");
const { spawn } = require("node:child_process");

function normalizeVersion(value) {
  return String(value ?? "")
    .trim()
    .replace(/^v/i, "");
}

function parseVersionParts(value) {
  const normalized = normalizeVersion(value);
  const [coreRaw, preReleaseRaw] = normalized.split("-", 2);
  const core = coreRaw
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
  return {
    core,
    preRelease: preReleaseRaw ?? "",
  };
}

function compareVersions(a, b) {
  const aParts = parseVersionParts(a);
  const bParts = parseVersionParts(b);
  const maxLen = Math.max(aParts.core.length, bParts.core.length);
  for (let index = 0; index < maxLen; index += 1) {
    const aValue = aParts.core[index] ?? 0;
    const bValue = bParts.core[index] ?? 0;
    if (aValue !== bValue) {
      return aValue > bValue ? 1 : -1;
    }
  }
  if (aParts.preRelease && !bParts.preRelease) {
    return -1;
  }
  if (!aParts.preRelease && bParts.preRelease) {
    return 1;
  }
  return aParts.preRelease.localeCompare(bParts.preRelease);
}

function getErrorMessage(error) {
  if (error instanceof Error) {
    const message = String(error.message ?? "").trim();
    if (message) {
      return message;
    }
  }
  return String(error ?? "").trim();
}

function isNoPublishedReleaseError(error) {
  const normalized = getErrorMessage(error).toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("/releases/latest") &&
    (normalized.includes("(404)") || normalized.includes("not found"))
  );
}

function requestWithRedirects(urlValue, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error("Too many redirects while requesting update metadata."));
      return;
    }

    const url = new URL(urlValue);
    const request = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: options.method || "GET",
        headers: options.headers || {},
      },
      (response) => {
        const statusCode = Number(response.statusCode ?? 0);
        const location = typeof response.headers.location === "string" ? response.headers.location : "";
        if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
          response.resume();
          const nextUrl = new URL(location, url).toString();
          requestWithRedirects(nextUrl, options, redirectCount + 1).then(resolve).catch(reject);
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => {
            reject(new Error(`Update request failed (${statusCode}): ${body.slice(0, 500)}`));
          });
          return;
        }

        resolve(response);
      },
    );

    request.on("error", reject);
    request.end();
  });
}

async function requestJson(url, headers) {
  const response = await requestWithRedirects(url, { headers });
  const chunks = [];
  for await (const chunk of response) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(body);
}

function pickReleaseAsset(assets, platform) {
  if (!Array.isArray(assets) || assets.length === 0) {
    return null;
  }

  const normalizedAssets = assets.filter((asset) => asset && typeof asset === "object");
  const names = normalizedAssets.map((asset) => String(asset.name ?? "").toLowerCase());
  const candidates = normalizedAssets.filter((asset) => {
    const name = String(asset.name ?? "").toLowerCase();
    if (!name || name.endsWith(".blockmap") || name.endsWith(".yml") || name.endsWith(".yaml")) {
      return false;
    }
    if (platform === "win32") {
      return name.endsWith(".exe") || name.endsWith(".msi");
    }
    if (platform === "darwin") {
      return name.endsWith(".dmg") || name.endsWith(".zip");
    }
    return name.endsWith(".appimage") || name.endsWith(".deb") || name.endsWith(".rpm") || name.endsWith(".tar.gz");
  });

  if (candidates.length === 0) {
    return null;
  }

  if (platform === "win32") {
    const setup = candidates.find((asset) => /setup|installer/i.test(String(asset.name ?? "")));
    return setup ?? candidates[0];
  }

  if (platform === "darwin") {
    const dmg = candidates.find((asset) => String(asset.name ?? "").toLowerCase().endsWith(".dmg"));
    return dmg ?? candidates[0];
  }

  const appImage = candidates.find((asset) => String(asset.name ?? "").toLowerCase().endsWith(".appimage"));
  return appImage ?? candidates[0];
}

function createInitialState(currentVersion) {
  return {
    enabled: true,
    status: "idle",
    currentVersion: normalizeVersion(currentVersion),
    latestVersion: null,
    releaseName: null,
    publishedAt: null,
    releaseNotes: null,
    assetName: null,
    downloadedBytes: 0,
    totalBytes: 0,
    progressPercent: 0,
    lastCheckedAt: null,
    errorMessage: null,
  };
}

function createAppUpdater(options) {
  const {
    app,
    shell,
    owner = "1blayze",
    repo = "Messly-updates",
    token = "",
    platform = process.platform,
    userAgent = `Messly-Updater/${app.getVersion()}`,
  } = options;

  let state = createInitialState(app.getVersion());
  let lastRelease = null;
  let downloadPath = null;
  let broadcast = () => {};
  let checkPromise = null;
  let downloadPromise = null;
  let autoCheckIntervalId = null;

  function emit() {
    broadcast({ ...state });
  }

  function setState(patch) {
    state = {
      ...state,
      ...patch,
    };
    emit();
  }

  function getAuthHeaders(extraHeaders = {}) {
    const headers = {
      "User-Agent": userAgent,
      Accept: "application/vnd.github+json",
      ...extraHeaders,
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  function getState() {
    return { ...state };
  }

  function setBroadcaster(nextBroadcaster) {
    broadcast = typeof nextBroadcaster === "function" ? nextBroadcaster : () => {};
    emit();
  }

  async function fetchLatestRelease() {
    const endpoint = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
    return requestJson(endpoint, getAuthHeaders());
  }

  async function checkForUpdates() {
    if (checkPromise) {
      return checkPromise;
    }

    checkPromise = (async () => {
      setState({
        status: "checking",
        errorMessage: null,
      });

      try {
        const release = await fetchLatestRelease();
        lastRelease = release;
        const latestVersion = normalizeVersion(release.tag_name || release.name || "");
        const currentVersion = normalizeVersion(app.getVersion());
        const chosenAsset = pickReleaseAsset(release.assets, platform);

        const hasUpdate =
          Boolean(latestVersion) &&
          compareVersions(latestVersion, currentVersion) > 0 &&
          Boolean(chosenAsset);

        downloadPath = null;
        setState({
          status: hasUpdate ? "available" : "unavailable",
          currentVersion,
          latestVersion: latestVersion || null,
          releaseName: String(release.name ?? "").trim() || null,
          publishedAt: String(release.published_at ?? "").trim() || null,
          releaseNotes: String(release.body ?? "").trim() || null,
          assetName: chosenAsset ? String(chosenAsset.name ?? "").trim() : null,
          downloadedBytes: 0,
          totalBytes: Number(chosenAsset?.size ?? 0) || 0,
          progressPercent: 0,
          lastCheckedAt: new Date().toISOString(),
          errorMessage: null,
        });
      } catch (error) {
        if (isNoPublishedReleaseError(error)) {
          setState({
            status: "unavailable",
            currentVersion: normalizeVersion(app.getVersion()),
            latestVersion: normalizeVersion(app.getVersion()) || null,
            releaseName: null,
            publishedAt: null,
            releaseNotes: null,
            assetName: null,
            downloadedBytes: 0,
            totalBytes: 0,
            progressPercent: 0,
            lastCheckedAt: new Date().toISOString(),
            errorMessage: null,
          });
          return getState();
        }
        setState({
          status: "error",
          errorMessage: getErrorMessage(error) || "Falha ao verificar atualização.",
          lastCheckedAt: new Date().toISOString(),
        });
      } finally {
        checkPromise = null;
      }

      return getState();
    })();

    return checkPromise;
  }

  async function ensureDownloadDir() {
    const targetDir = path.join(app.getPath("temp"), "messly-updates");
    await fsp.mkdir(targetDir, { recursive: true });
    return targetDir;
  }

  async function downloadUpdate() {
    if (downloadPromise) {
      return downloadPromise;
    }

    downloadPromise = (async () => {
      if (!lastRelease) {
        await checkForUpdates();
      }

      if (!lastRelease) {
        throw new Error("Release de atualização indisponível.");
      }

      const asset = pickReleaseAsset(lastRelease.assets, platform);
      if (!asset) {
        throw new Error("Nenhum instalador compatível encontrado.");
      }

      const assetApiUrl = String(asset.url ?? "").trim();
      if (!assetApiUrl) {
        throw new Error("Asset de atualização inválido.");
      }

      const fileName = String(asset.name ?? "").trim() || `messly-update-${Date.now()}`;
      const dir = await ensureDownloadDir();
      const tempFilePath = path.join(dir, `${fileName}.download`);
      const finalFilePath = path.join(dir, fileName);

      setState({
        status: "downloading",
        assetName: fileName,
        errorMessage: null,
        downloadedBytes: 0,
        totalBytes: Number(asset.size ?? 0) || 0,
        progressPercent: 0,
      });

      const response = await requestWithRedirects(assetApiUrl, {
        headers: getAuthHeaders({
          Accept: "application/octet-stream",
        }),
      });

      const totalBytesHeader = Number.parseInt(String(response.headers["content-length"] ?? ""), 10);
      const totalBytes = Number.isFinite(totalBytesHeader) && totalBytesHeader > 0
        ? totalBytesHeader
        : Number(asset.size ?? 0) || 0;
      let downloadedBytes = 0;

      await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(tempFilePath);
        response.on("data", (chunk) => {
          downloadedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
          const progressPercent = totalBytes > 0 ? Math.min(100, (downloadedBytes / totalBytes) * 100) : 0;
          setState({
            status: "downloading",
            downloadedBytes,
            totalBytes,
            progressPercent,
          });
        });
        response.on("error", (error) => {
          writer.destroy(error);
        });
        writer.on("error", reject);
        writer.on("finish", resolve);
        response.pipe(writer);
      });

      try {
        await fsp.rm(finalFilePath, { force: true });
      } catch {}
      await fsp.rename(tempFilePath, finalFilePath);
      downloadPath = finalFilePath;

      setState({
        status: "downloaded",
        downloadedBytes: totalBytes || downloadedBytes,
        totalBytes,
        progressPercent: 100,
        errorMessage: null,
      });

      return {
        state: getState(),
        filePath: finalFilePath,
      };
    })()
      .catch((error) => {
        setState({
          status: "error",
          errorMessage: error instanceof Error ? error.message : "Falha no download da atualização.",
        });
        throw error;
      })
      .finally(() => {
        downloadPromise = null;
      });

    return downloadPromise;
  }

  async function installUpdate() {
    if (!downloadPath) {
      throw new Error("Atualizacao ainda nao foi baixada.");
    }

    setState({
      status: "installing",
      errorMessage: null,
      progressPercent: 100,
      downloadedBytes: state.totalBytes || state.downloadedBytes,
    });

    const targetPath = downloadPath;
    if (platform === "win32") {
      const child = spawn(targetPath, ["/S"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      app.quit();
      return { launched: true };
    }

    const openError = await shell.openPath(targetPath);
    if (openError) {
      throw new Error(openError);
    }
    app.quit();
    return { launched: true };
  }

  function startAutoCheck(intervalMs = 30 * 60 * 1000) {
    if (autoCheckIntervalId != null) {
      clearInterval(autoCheckIntervalId);
      autoCheckIntervalId = null;
    }
    void checkForUpdates();
    autoCheckIntervalId = setInterval(() => {
      void checkForUpdates();
    }, Math.max(60_000, Number(intervalMs) || 30 * 60 * 1000));
  }

  function stopAutoCheck() {
    if (autoCheckIntervalId != null) {
      clearInterval(autoCheckIntervalId);
      autoCheckIntervalId = null;
    }
  }

  return {
    getState,
    setBroadcaster,
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    startAutoCheck,
    stopAutoCheck,
  };
}

module.exports = {
  createAppUpdater,
};
