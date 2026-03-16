const { contextBridge, ipcRenderer } = require("electron");
const NOTIFICATION_DEBUG_ENABLED = Boolean(process.defaultApp || process.env.NODE_ENV === "development");

function logNotificationDebug(event, details = {}) {
  if (!NOTIFICATION_DEBUG_ENABLED) {
    return;
  }
  try {
    console.debug(`[notifications:preload] ${event}`, details);
  } catch {}
}

const STARTUP_SNAPSHOT_FALLBACK = Object.freeze({
  generatedAt: new Date().toISOString(),
  appVersion: null,
  hasRefreshToken: false,
  secureStorageAvailable: false,
  windowsSettings: null,
  apiConfig: null,
  cacheHints: null,
});

const startupSnapshotPromise = ipcRenderer
  .invoke("app:get-startup-snapshot")
  .then((snapshot) => {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      return STARTUP_SNAPSHOT_FALLBACK;
    }
    return snapshot;
  })
  .catch(() => STARTUP_SNAPSHOT_FALLBACK);

const electronAPI = Object.freeze({
  platform: process.platform,
  arch: process.arch,
  isPackaged: !process.defaultApp,
  getStartupSnapshot: () => startupSnapshotPromise,
  signalRendererFirstFrameReady: (payload) => ipcRenderer.send("app:renderer-first-frame-ready", payload),
  getSignedMediaUrl: (payload) => ipcRenderer.invoke("media:get-signed-url", payload),
  uploadProfileMedia: (payload) => ipcRenderer.invoke("media:upload-profile", payload),
  uploadAttachment: (payload) => ipcRenderer.invoke("media:upload-attachment", payload),
  downloadRemoteFile: (payload) => ipcRenderer.invoke("media:download-remote-file", payload),
  openExternalUrl: (payload) => ipcRenderer.invoke("shell:open-external", payload),
  getPendingSpotifyOAuthCallback: (payload) => ipcRenderer.invoke("spotify:get-pending-callback", payload),
  spotifyPresenceGetState: (payload) => ipcRenderer.invoke("spotify:presence:get-state", payload),
  spotifyPresenceConnect: (payload) => ipcRenderer.invoke("spotify:presence:connect", payload),
  spotifyPresenceDisconnect: (payload) => ipcRenderer.invoke("spotify:presence:disconnect", payload),
  spotifyPresenceSetVisibility: (payload) => ipcRenderer.invoke("spotify:presence:set-visibility", payload),
  spotifyPresenceStart: (payload) => ipcRenderer.invoke("spotify:presence:start", payload),
  spotifyPresenceStop: (payload) => ipcRenderer.invoke("spotify:presence:stop", payload),
  spotifyPresencePollOnce: (payload) => ipcRenderer.invoke("spotify:presence:poll-once", payload),
  spotifyPresenceDebugState: (payload) => ipcRenderer.invoke("spotify:presence:debug-state", payload),
  getScreenShareSources: (options) => ipcRenderer.invoke("screenshare:get-sources", options),
  setWindowAttention: (payload) => ipcRenderer.invoke("window:set-attention", payload),
  updaterGetState: () => ipcRenderer.invoke("updater:get-state"),
  updaterCheck: () => ipcRenderer.invoke("updater:check"),
  updaterDownload: () => ipcRenderer.invoke("updater:download"),
  updaterInstall: () => ipcRenderer.invoke("updater:install"),
  getWindowsSettings: () => ipcRenderer.invoke("windows-settings:get"),
  updateWindowsSettings: (payload) => ipcRenderer.invoke("windows-settings:update", payload),
  restoreMainWindowFromTray: () => ipcRenderer.invoke("windows-settings:restore-window"),
  getWindowsNetworkDiagnostics: () => ipcRenderer.invoke("windows-network:diagnostics"),
  getHiddenDirectMessageConversationIds: (payload) => ipcRenderer.invoke("direct-messages:hidden:get", payload),
  setHiddenDirectMessageConversationIds: (payload) => ipcRenderer.invoke("direct-messages:hidden:set", payload),
  getSecureStoreItem: (payload) => ipcRenderer.invoke("auth:storage:get", payload),
  setSecureStoreItem: (payload) => ipcRenderer.invoke("auth:storage:set", payload),
  removeSecureStoreItem: (payload) => ipcRenderer.invoke("auth:storage:remove", payload),
  logDiagnostic: (payload) => ipcRenderer.invoke("diagnostics:log", payload),
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
  onSpotifyOAuthCallback: (listener) => {
    if (typeof listener !== "function") {
      return () => {};
    }
    const wrapped = (_event, payload) => {
      listener(payload);
    };
    ipcRenderer.on("spotify:oauth-callback", wrapped);
    return () => {
      ipcRenderer.removeListener("spotify:oauth-callback", wrapped);
    };
  },
  onSpotifyPresenceUpdate: (listener) => {
    if (typeof listener !== "function") {
      return () => {};
    }
    const wrapped = (_event, payload) => {
      listener(payload);
    };
    ipcRenderer.on("spotify:presence:update", wrapped);
    return () => {
      ipcRenderer.removeListener("spotify:presence:update", wrapped);
    };
  },
  versions: Object.freeze({
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  }),
});

const MAX_PENDING_NOTIFICATION_OPEN_CONVERSATIONS = 16;
const notificationOpenConversationListeners = new Set();
const pendingNotificationOpenConversations = [];

function normalizeOpenConversationPayload(payload) {
  const conversationId = String(payload?.conversationId ?? "").trim();
  if (!conversationId) {
    return null;
  }

  const messageId = String(payload?.messageId ?? "").trim();
  const eventId = String(payload?.eventId ?? "").trim();
  const source = String(payload?.source ?? "").trim();
  return {
    conversationId,
    ...(messageId ? { messageId } : {}),
    ...(eventId ? { eventId } : {}),
    ...(source ? { source } : {}),
  };
}

function pushPendingOpenConversation(payload) {
  pendingNotificationOpenConversations.push(payload);
  if (pendingNotificationOpenConversations.length > MAX_PENDING_NOTIFICATION_OPEN_CONVERSATIONS) {
    pendingNotificationOpenConversations.splice(
      0,
      pendingNotificationOpenConversations.length - MAX_PENDING_NOTIFICATION_OPEN_CONVERSATIONS,
    );
  }
}

ipcRenderer.on("notifications:open-conversation", (_event, payload) => {
  const normalizedPayload = normalizeOpenConversationPayload(payload);
  if (!normalizedPayload) {
    return;
  }

  pushPendingOpenConversation(normalizedPayload);
  logNotificationDebug("open_conversation_received", {
    conversationId: normalizedPayload.conversationId,
    messageId: normalizedPayload.messageId ?? null,
    eventId: normalizedPayload.eventId ?? null,
    pendingCount: pendingNotificationOpenConversations.length,
    listenerCount: notificationOpenConversationListeners.size,
  });
  for (const listener of notificationOpenConversationListeners) {
    try {
      listener(normalizedPayload);
    } catch {}
  }
});

const notificationsAPI = Object.freeze({
  notifyMessage: (payload) => ipcRenderer.invoke("notifications:notify-message", payload),
  notifyCall: (payload) => ipcRenderer.invoke("notifications:notify-call", payload),
  onOpenConversation: (listener) => {
    if (typeof listener !== "function") {
      return () => {};
    }
    notificationOpenConversationListeners.add(listener);
    return () => {
      notificationOpenConversationListeners.delete(listener);
    };
  },
  notifyRendererReady: () => ipcRenderer.send("notifications:renderer-ready"),
  consumePendingOpenConversations: () => {
    if (pendingNotificationOpenConversations.length === 0) {
      return [];
    }
    const pending = pendingNotificationOpenConversations.splice(0, pendingNotificationOpenConversations.length);
    logNotificationDebug("pending_navigation_consumed", {
      source: "preload-consume",
      count: pending.length,
    });
    return pending;
  },
});

const messlyAuthApi = Object.freeze({
  saveRefreshToken: (token) => ipcRenderer.invoke("auth:refresh-token:set", token),
  loadRefreshToken: () => ipcRenderer.invoke("auth:refresh-token:get"),
  clearRefreshToken: () => ipcRenderer.invoke("auth:refresh-token:remove"),
});

contextBridge.exposeInMainWorld("electronAPI", electronAPI);
contextBridge.exposeInMainWorld("messlyAuth", messlyAuthApi);
contextBridge.exposeInMainWorld("notifications", notificationsAPI);
