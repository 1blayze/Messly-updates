const path = require("node:path");
const { autoUpdater } = require("electron-updater");

function safeString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function pickAssetMetadata(info) {
  const files = Array.isArray(info?.files) ? info.files : [];
  for (const file of files) {
    const fromName = safeString(file?.name);
    const size = Number(file?.size ?? 0);
    const normalizedSize = Number.isFinite(size) && size > 0 ? Math.trunc(size) : 0;
    if (fromName) {
      return {
        name: fromName,
        size: normalizedSize,
      };
    }
    const fromUrl = safeString(file?.url);
    if (fromUrl) {
      return {
        name: path.basename(fromUrl),
        size: normalizedSize,
      };
    }
  }
  return {
    name: null,
    size: 0,
  };
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
    bytesPerSecond: 0,
    progressPercent: 0,
    lastCheckedAt: null,
    errorMessage: null,
  };

  let broadcast = () => {};
  let autoCheckTimer = null;
  let latestDownloadedFile = "";
  let checkPromise = null;
  let downloadPromise = null;
  let installPromise = null;

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
      bytesPerSecond: 0,
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
    const asset = pickAssetMetadata(info);
    state.assetName = asset.name ?? state.assetName;
    if (asset.size > 0) {
      state.totalBytes = asset.size;
    }
  };

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;

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
      bytesPerSecond: 0,
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
      bytesPerSecond: 0,
      lastCheckedAt: new Date().toISOString(),
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    setState({
      status: "downloading",
      errorMessage: null,
      downloadedBytes: Number(progress?.transferred ?? 0) || 0,
      totalBytes: Number(progress?.total ?? 0) || 0,
      bytesPerSecond: Number(progress?.bytesPerSecond ?? 0) || 0,
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
      bytesPerSecond: 0,
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
    if (checkPromise) {
      return checkPromise;
    }

    checkPromise = (async () => {
      try {
        setState({
          status: "checking",
          errorMessage: null,
          lastCheckedAt: new Date().toISOString(),
        });
        const result = await autoUpdater.checkForUpdates();
        const updateInfo = result?.updateInfo;
        if (updateInfo) {
          applyInfoToState(updateInfo);
        }
        if (String(state.status ?? "").trim().toLowerCase() === "checking") {
          setUnavailableState();
        }
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
      if (currentStatus === "downloaded") {
        return {
          state: { ...state },
          filePath: latestDownloadedFile,
        };
      }

      if (currentStatus !== "available" && currentStatus !== "downloading") {
        await checkForUpdates();
      }

      const statusAfterCheck = String(state.status ?? "").trim().toLowerCase();
      if (statusAfterCheck !== "available" && statusAfterCheck !== "downloading" && statusAfterCheck !== "downloaded") {
        throw new Error("Nenhuma atualizacao disponivel para download.");
      }

      setState({
        status: "downloading",
        errorMessage: null,
        downloadedBytes: 0,
        totalBytes: Number(state.totalBytes ?? 0) || 0,
        bytesPerSecond: 0,
        progressPercent: 0,
      });

      const result = await autoUpdater.downloadUpdate();
      const filePath = Array.isArray(result) ? String(result[0] ?? "") : String(result ?? "");
      latestDownloadedFile = filePath || latestDownloadedFile;
      if (String(state.status ?? "").trim().toLowerCase() !== "downloaded") {
        setState({
          status: "downloaded",
          errorMessage: null,
          downloadedBytes: state.totalBytes || state.downloadedBytes,
          bytesPerSecond: 0,
          progressPercent: 100,
        });
      }
      return {
        state: { ...state },
        filePath: latestDownloadedFile,
      };
    })()
      .catch((error) => {
        const message = getErrorMessage(error) || "Falha ao baixar atualizacao.";
        setState({
          status: "error",
          errorMessage: message,
          bytesPerSecond: 0,
        });
        throw new Error(message);
      })
      .finally(() => {
        downloadPromise = null;
      });

    return downloadPromise;
  }

  async function installUpdate() {
    if (installPromise) {
      return installPromise;
    }

    if (state.status !== "downloaded") {
      throw new Error("Atualizacao ainda nao foi baixada.");
    }

    installPromise = (async () => {
      setState({
        status: "installing",
        errorMessage: null,
        progressPercent: 100,
        downloadedBytes: state.totalBytes || state.downloadedBytes,
        bytesPerSecond: 0,
      });

      await new Promise((resolve) => {
        setTimeout(resolve, 80);
      });

      setState({
        status: "relaunching",
        errorMessage: null,
        progressPercent: 100,
        downloadedBytes: state.totalBytes || state.downloadedBytes,
        bytesPerSecond: 0,
      });

      setImmediate(() => {
        try {
          autoUpdater.quitAndInstall(true, true);
        } catch (error) {
          const message = getErrorMessage(error) || "Falha ao aplicar atualizacao.";
          setState({
            status: "error",
            errorMessage: message,
          });
        }
      });

      return {
        launched: true,
      };
    })()
      .finally(() => {
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
      void checkForUpdates().catch(() => {});
    }
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
