const path = require("node:path");
const { autoUpdater } = require("electron-updater");

function safeString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function pickAssetName(info) {
  const files = Array.isArray(info?.files) ? info.files : [];
  for (const file of files) {
    const fromName = safeString(file?.name);
    if (fromName) {
      return fromName;
    }
    const fromUrl = safeString(file?.url);
    if (fromUrl) {
      return path.basename(fromUrl);
    }
  }
  return null;
}

function normalizeReleaseNotes(rawNotes) {
  if (Array.isArray(rawNotes)) {
    const parts = rawNotes
      .map((item) => {
        if (!item || typeof item !== "object") {
          return "";
        }
        const version = safeString(item.version);
        const note = safeString(item.note);
        if (!version && !note) {
          return "";
        }
        return version ? `${version}\n${note ?? ""}`.trim() : note ?? "";
      })
      .filter(Boolean);
    return parts.length > 0 ? parts.join("\n\n") : null;
  }
  return safeString(rawNotes);
}

function getErrorMessage(error) {
  return safeString(error instanceof Error ? error.message : String(error ?? "")) ?? "";
}

function isNoPublishedReleaseError(error) {
  const normalized = getErrorMessage(error).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.includes("no published versions on github")) {
    return true;
  }
  return normalized.includes("latest version on github") && (
    normalized.includes("production release exists") ||
    normalized.includes("release exists")
  );
}

function createElectronUpdaterAdapter({ app }) {
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
    progressPercent: 0,
    lastCheckedAt: null,
    errorMessage: null,
  };

  let broadcast = () => {};
  let autoCheckTimer = null;
  let latestDownloadedFile = "";

  const emit = () => {
    try {
      broadcast({ ...state });
    } catch {}
  };

  const setState = (patch) => {
    Object.assign(state, patch);
    emit();
  };

  const setUnavailableState = (patch = {}) => {
    setState({
      status: "unavailable",
      latestVersion: null,
      releaseName: null,
      publishedAt: null,
      releaseNotes: null,
      assetName: null,
      downloadedBytes: 0,
      totalBytes: 0,
      progressPercent: 0,
      errorMessage: null,
      lastCheckedAt: new Date().toISOString(),
      ...patch,
    });
  };

  const applyInfoToState = (info) => {
    if (!info || typeof info !== "object") {
      return;
    }
    state.latestVersion = safeString(info.version) ?? state.latestVersion;
    state.releaseName = safeString(info.releaseName) ?? state.releaseName;
    state.publishedAt = safeString(info.releaseDate) ?? state.publishedAt;
    state.releaseNotes = normalizeReleaseNotes(info.releaseNotes) ?? state.releaseNotes;
    state.assetName = pickAssetName(info) ?? state.assetName;
  };

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("checking-for-update", () => {
    setState({
      status: "checking",
      errorMessage: null,
      lastCheckedAt: new Date().toISOString(),
    });
  });

  autoUpdater.on("update-available", (info) => {
    applyInfoToState(info);
    setState({
      status: "available",
      errorMessage: null,
      progressPercent: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      lastCheckedAt: new Date().toISOString(),
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    applyInfoToState(info);
    setState({
      status: "unavailable",
      errorMessage: null,
      progressPercent: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      lastCheckedAt: new Date().toISOString(),
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    setState({
      status: "downloading",
      errorMessage: null,
      downloadedBytes: Number(progress?.transferred ?? 0) || 0,
      totalBytes: Number(progress?.total ?? 0) || 0,
      progressPercent: Number(progress?.percent ?? 0) || 0,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    applyInfoToState(info);
    setState({
      status: "downloaded",
      errorMessage: null,
      progressPercent: 100,
      downloadedBytes: state.totalBytes || state.downloadedBytes,
    });
  });

  autoUpdater.on("error", (error) => {
    if (isNoPublishedReleaseError(error)) {
      setUnavailableState();
      return;
    }
    setState({
      status: "error",
      errorMessage: getErrorMessage(error) || "Falha no updater.",
      lastCheckedAt: new Date().toISOString(),
    });
  });

  async function checkForUpdates() {
    try {
      await autoUpdater.checkForUpdates();
      return { ...state };
    } catch (error) {
      if (isNoPublishedReleaseError(error)) {
        setUnavailableState();
        return { ...state };
      }
      const message = getErrorMessage(error) || "Falha ao verificar atualizacao.";
      setState({
        status: "error",
        errorMessage: message,
        lastCheckedAt: new Date().toISOString(),
      });
      throw new Error(message);
    }
  }

  async function downloadUpdate() {
    try {
      const result = await autoUpdater.downloadUpdate();
      const filePath = Array.isArray(result) ? String(result[0] ?? "") : String(result ?? "");
      latestDownloadedFile = filePath || latestDownloadedFile;
      return {
        state: { ...state },
        filePath: latestDownloadedFile,
      };
    } catch (error) {
      const message = getErrorMessage(error) || "Falha ao baixar atualizacao.";
      setState({
        status: "error",
        errorMessage: message,
      });
      throw new Error(message);
    }
  }

  async function installUpdate() {
    if (state.status !== "downloaded") {
      throw new Error("Atualizacao ainda nao foi baixada.");
    }
    setState({
      status: "installing",
      errorMessage: null,
      progressPercent: 100,
      downloadedBytes: state.totalBytes || state.downloadedBytes,
    });
    setImmediate(() => {
      try {
        autoUpdater.quitAndInstall(true, true);
      } catch {}
    });
    return {
      launched: true,
    };
  }

  function startAutoCheck(intervalMs) {
    if (autoCheckTimer) {
      clearInterval(autoCheckTimer);
      autoCheckTimer = null;
    }
    void checkForUpdates().catch(() => {});
    const safeInterval = Number(intervalMs);
    const delay = Number.isFinite(safeInterval) && safeInterval >= 60_000 ? Math.trunc(safeInterval) : 30 * 60 * 1000;
    autoCheckTimer = setInterval(() => {
      void checkForUpdates().catch(() => {});
    }, delay);
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
  createElectronUpdaterAdapter,
};
