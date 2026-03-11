const MAX_PENDING_NAVIGATIONS = 20;

function normalizeNavigationPayload(rawPayload) {
  const conversationId = String(rawPayload?.conversationId ?? "").trim();
  if (!conversationId) {
    return null;
  }

  const messageId = String(rawPayload?.messageId ?? "").trim();
  const eventId = String(rawPayload?.eventId ?? "").trim();
  const source = String(rawPayload?.source ?? "").trim();
  return {
    conversationId,
    ...(messageId ? { messageId } : {}),
    ...(eventId ? { eventId } : {}),
    ...(source ? { source } : {}),
  };
}

class NotificationNavigationCoordinator {
  constructor(options = {}) {
    this.getMainWindow = typeof options.getMainWindow === "function" ? options.getMainWindow : () => null;
    this.createMainWindow = typeof options.createMainWindow === "function" ? options.createMainWindow : () => null;
    this.showMainWindow = typeof options.showMainWindow === "function" ? options.showMainWindow : () => false;
    this.ipcChannel = String(options.ipcChannel ?? "notifications:open-conversation");
    this.debugLog = typeof options.debugLog === "function" ? options.debugLog : () => {};
    this.pendingNavigations = [];
    this.rendererReadyByWebContentsId = new Map();
    this.windowCleanupById = new Map();
  }

  registerWindow(window) {
    if (!window || window.isDestroyed?.()) {
      return;
    }
    if (this.windowCleanupById.has(window.id)) {
      return;
    }

    const webContents = window.webContents;
    if (webContents && !webContents.isDestroyed?.()) {
      this.rendererReadyByWebContentsId.set(webContents.id, false);
    }

    const handleDidStartLoading = () => {
      if (!webContents || webContents.isDestroyed?.()) {
        return;
      }
      this.rendererReadyByWebContentsId.set(webContents.id, false);
    };
    const handleDestroyed = () => {
      if (webContents && !webContents.isDestroyed?.()) {
        this.rendererReadyByWebContentsId.delete(webContents.id);
      }
      this.unregisterWindow(window.id);
    };

    webContents?.on?.("did-start-loading", handleDidStartLoading);
    window.on?.("closed", handleDestroyed);
    this.windowCleanupById.set(window.id, () => {
      webContents?.removeListener?.("did-start-loading", handleDidStartLoading);
      window.removeListener?.("closed", handleDestroyed);
      if (webContents && !webContents.isDestroyed?.()) {
        this.rendererReadyByWebContentsId.delete(webContents.id);
      }
    });
  }

  unregisterWindow(windowId) {
    const cleanup = this.windowCleanupById.get(windowId);
    this.windowCleanupById.delete(windowId);
    if (typeof cleanup === "function") {
      cleanup();
    }
  }

  markRendererReady(webContents, ready = true) {
    if (!webContents || webContents.isDestroyed?.()) {
      return;
    }
    this.rendererReadyByWebContentsId.set(webContents.id, Boolean(ready));
    if (ready) {
      this.flushPending(webContents);
    }
  }

  handleNotificationClick(rawPayload) {
    const payload = normalizeNavigationPayload(rawPayload);
    if (!payload) {
      return;
    }

    this.enqueueNavigation(payload);
    const mainWindow = this.ensureMainWindow();
    if (!mainWindow || mainWindow.isDestroyed?.()) {
      return;
    }
    this.focusWindow(mainWindow);
    this.flushPending(mainWindow.webContents);
  }

  dispose() {
    for (const windowId of this.windowCleanupById.keys()) {
      this.unregisterWindow(windowId);
    }
    this.pendingNavigations = [];
    this.rendererReadyByWebContentsId.clear();
  }

  enqueueNavigation(payload) {
    this.pendingNavigations = this.pendingNavigations.filter((pending) => {
      const sameConversation = pending.conversationId === payload.conversationId;
      const sameMessage = String(pending.messageId ?? "") === String(payload.messageId ?? "");
      return !(sameConversation && sameMessage);
    });
    this.pendingNavigations.push(payload);
    this.debugLog("click_queued", {
      conversationId: payload.conversationId,
      messageId: payload.messageId ?? null,
      eventId: payload.eventId ?? null,
      pendingCount: this.pendingNavigations.length,
    });
    if (this.pendingNavigations.length > MAX_PENDING_NAVIGATIONS) {
      this.pendingNavigations.splice(0, this.pendingNavigations.length - MAX_PENDING_NAVIGATIONS);
    }
  }

  ensureMainWindow() {
    let mainWindow = this.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed?.()) {
      this.createMainWindow();
      mainWindow = this.getMainWindow();
    }
    if (mainWindow && !mainWindow.isDestroyed?.()) {
      this.registerWindow(mainWindow);
    }
    return mainWindow;
  }

  focusWindow(window) {
    if (!window || window.isDestroyed?.()) {
      return;
    }

    const shown = this.showMainWindow();
    if (!shown) {
      return;
    }

    if (window.isMinimized?.()) {
      window.restore?.();
    }
    if (!window.isVisible?.()) {
      window.show?.();
    }
    window.focus?.();
  }

  flushPending(targetWebContents) {
    if (!targetWebContents || targetWebContents.isDestroyed?.()) {
      return;
    }
    const isRendererReady = this.rendererReadyByWebContentsId.get(targetWebContents.id) === true;
    if (!isRendererReady) {
      return;
    }
    if (this.pendingNavigations.length === 0) {
      return;
    }

    const queue = [...this.pendingNavigations];
    this.pendingNavigations = [];
    this.debugLog("pending_navigation_consumed", {
      webContentsId: targetWebContents.id,
      count: queue.length,
    });
    for (const payload of queue) {
      targetWebContents.send(this.ipcChannel, payload);
    }
  }
}

module.exports = {
  NotificationNavigationCoordinator,
};
