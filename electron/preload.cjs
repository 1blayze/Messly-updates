const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  arch: process.arch,
  getSignedMediaUrl: (payload) => ipcRenderer.invoke("media:get-signed-url", payload),
  uploadProfileMedia: (payload) => ipcRenderer.invoke("media:upload-profile", payload),
  uploadAttachment: (payload) => ipcRenderer.invoke("media:upload-attachment", payload),
  openExternalUrl: (payload) => ipcRenderer.invoke("shell:open-external", payload),
  getScreenShareSources: (options) => ipcRenderer.invoke("screenshare:get-sources", options),
  setWindowAttention: (payload) => ipcRenderer.invoke("window:set-attention", payload),
  updaterGetState: () => ipcRenderer.invoke("updater:get-state"),
  updaterCheck: () => ipcRenderer.invoke("updater:check"),
  updaterDownload: () => ipcRenderer.invoke("updater:download"),
  updaterInstall: () => ipcRenderer.invoke("updater:install"),
  getWindowsSettings: () => ipcRenderer.invoke("windows-settings:get"),
  updateWindowsSettings: (payload) => ipcRenderer.invoke("windows-settings:update", payload),
  restoreMainWindowFromTray: () => ipcRenderer.invoke("windows-settings:restore-window"),
  onUpdaterStateChanged: (listener) => {
    if (typeof listener !== "function") {
      return () => {};
    }
    const wrapped = (_event, payload) => {
      listener(payload);
    };
    ipcRenderer.on("updater:state-changed", wrapped);
    return () => {
      ipcRenderer.removeListener("updater:state-changed", wrapped);
    };
  },
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  },
});
