const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  getSignedMediaUrl: (payload) => ipcRenderer.invoke("media:get-signed-url", payload),
  uploadProfileMedia: (payload) => ipcRenderer.invoke("media:upload-profile", payload),
  uploadAttachment: (payload) => ipcRenderer.invoke("media:upload-attachment", payload),
  openExternalUrl: (payload) => ipcRenderer.invoke("shell:open-external", payload),
  getScreenShareSources: (options) => ipcRenderer.invoke("screenshare:get-sources", options),
  setWindowAttention: (payload) => ipcRenderer.invoke("window:set-attention", payload),
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  },
});
