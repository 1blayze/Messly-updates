const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

dotenv.config({
  path: path.resolve(__dirname, "..", ".env"),
  quiet: true,
});

dotenv.config({
  path: path.resolve(__dirname, "..", ".env.local"),
  override: true,
  quiet: true,
});

const { app, BrowserWindow, BrowserView, Tray, desktopCapturer, ipcMain, Menu, shell, nativeImage, dialog, session, safeStorage, Notification } = require("electron");
const { APP_ID, APP_NAME, WINDOWS_APP_USER_MODEL_ID } = require("./config/appIdentity.cjs");
const { getBackendEnv } = require("./config/env.cjs");
const { createMediaUploadError, isMediaUploadError } = require("./media/uploadErrors.cjs");
const { createAppUpdater } = require("./update/appUpdater.cjs");
const { createElectronUpdaterAdapter } = require("./update/electronUpdaterAdapter.cjs");
const { createNotificationManager } = require("./notifications/notificationManager.cjs");
const { NotificationNavigationCoordinator } = require("./notifications/notificationNavigationCoordinator.cjs");
const {
  DEFAULT_FIREWALL_PROFILE,
  DEFAULT_FIREWALL_RULE_NAME,
  getInstalledExePath,
  ensureWindowsFirewallRule,
  collectWindowsNetworkDiagnostics,
} = require("./windows/firewall.cjs");

// Keep Electron security warnings visible in production, but avoid noisy
// dev-only CSP warnings caused by tooling that relies on eval checks.
if (!app.isPackaged && process.env.ELECTRON_ENABLE_SECURITY_WARNINGS !== "true") {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
}

if (typeof app.setName === "function") {
  app.setName(APP_NAME);
}

if (app.commandLine && typeof app.commandLine.appendSwitch === "function") {
  app.commandLine.appendSwitch("enable-gpu-rasterization");
  app.commandLine.appendSwitch("enable-zero-copy");
}

const DEV_SERVER_URL = "http://127.0.0.1:5173";
const CALL_POPOUT_FRAME_NAME = "messly_call_popout";
const CALL_POPOUT_URL_MARKER = "#messly_call_popout";
const PROFILE_MEDIA_CACHE_CONTROL = "public, max-age=31536000, immutable";
const PROFILE_MEDIA_PREFIX_BY_KIND = Object.freeze({
  avatar: "avatars",
  banner: "banners",
});
const ALLOWED_MEDIA_PREFIXES = Object.freeze(["avatars/", "banners/", "attachments/", "images/", "videos/"]);
const SAFE_MEDIA_KEY_REGEX = /^[a-z0-9/_\-.]+$/i;
const MIN_SIGNED_URL_TTL_SECONDS = 60;
const MAX_SIGNED_URL_TTL_SECONDS = 300;
const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;
const START_MINIMIZED_ARG = "--start-minimized";
const APP_STARTUP_BACKGROUND_COLOR = "#111314";
const SPOTIFY_OAUTH_CALLBACK_CHANNEL = "spotify:oauth-callback";
const MESSLY_PROTOCOL_SCHEME = "messly";
const SPOTIFY_CALLBACK_HOST = "callback";
const APP_ICONS_DIR = path.resolve(__dirname, "..", "src", "assets", "icons", "app");
const APP_NOTIFICATION_ICON_ICO_PATH = path.resolve(__dirname, "..", "assets", "icons", "messly.ico");
const APP_NOTIFICATION_ICON_PNG_PATH = path.resolve(
  __dirname,
  "..",
  "src",
  "assets",
  "icons",
  "app",
  "messly-notification.png",
);
const STATUS_PANEL_MASCOT_PATH = path.resolve(__dirname, "..", "src", "assets", "icons", "ui", "messly.svg");
const WINDOWS_BEHAVIOR_SETTINGS_FILE = "windows-behavior-settings.json";
const HIDDEN_DIRECT_MESSAGES_STATE_FILE = "hidden-direct-messages-state.json";
const SECURE_AUTH_STORAGE_FILE = "secure-auth-storage.json";
const SECURE_AUTH_STORAGE_KEY_REGEX = /^[a-z0-9:_./-]{1,200}$/i;
const REFRESH_TOKEN_STORAGE_KEY = "messly.auth.refresh-token";
const LEGACY_SESSION_STORAGE_KEY = "messly.auth.session";
const DEFAULT_WINDOWS_BEHAVIOR_SETTINGS = Object.freeze({
  startMinimized: true,
  closeToTray: true,
  launchAtStartup: true,
});
const DEFAULT_HIDDEN_DIRECT_MESSAGES_STATE = Object.freeze({
  version: 1,
  hiddenConversationIdsByScope: Object.freeze({}),
});
const EMBEDDED_DEVTOOLS_RIGHT_RATIO = 0.4;
const EMBEDDED_DEVTOOLS_MIN_WIDTH_PX = 420;
const EMBEDDED_DEVTOOLS_MAX_WIDTH_RATIO = 0.65;
const WINDOWS_NOTIFICATION_ICON_SIZE = 128;
const EXTRA_ALLOWED_HTTPS_ORIGINS = Object.freeze(
  String(process.env.ELECTRON_ALLOWED_HTTPS_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const isDevEnvironment = !app.isPackaged;
const PACKAGED_DEVTOOLS_ENV = String(process.env.MESSLY_ENABLE_PACKAGED_DEVTOOLS ?? "").trim().toLowerCase();
const isPackagedDevToolsEnabled = PACKAGED_DEVTOOLS_ENV
  ? !["0", "false", "off", "no"].includes(PACKAGED_DEVTOOLS_ENV)
  : true;
const areDevToolsEnabled = !app.isPackaged || isPackagedDevToolsEnabled;
const TURNSTILE_CSP_SOURCE = "https://challenges.cloudflare.com";
const PRODUCTION_SCRIPT_SOURCE = areDevToolsEnabled
  ? `script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' ${TURNSTILE_CSP_SOURCE}`
  : `script-src 'self' 'wasm-unsafe-eval' ${TURNSTILE_CSP_SOURCE}`;
// Applied to packaged builds to lock down renderer document capabilities.
const PRODUCTION_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  PRODUCTION_SCRIPT_SOURCE,
  `script-src-elem 'self' ${TURNSTILE_CSP_SOURCE}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https: wss:",
  `frame-src 'self' ${TURNSTILE_CSP_SOURCE}`,
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");
const ALLOWED_APP_PERMISSIONS = Object.freeze(["media", "display-capture"]);
const WINDOWS_FIREWALL_RULE_NAME = String(process.env.MESSLY_FIREWALL_RULE_NAME ?? DEFAULT_FIREWALL_RULE_NAME).trim() || DEFAULT_FIREWALL_RULE_NAME;
const WINDOWS_FIREWALL_PROFILE = String(process.env.MESSLY_FIREWALL_PROFILE ?? DEFAULT_FIREWALL_PROFILE).trim().toLowerCase() || DEFAULT_FIREWALL_PROFILE;

function resolveAppIconPath(fileName) {
  const iconPath = path.join(APP_ICONS_DIR, fileName);
  return fs.existsSync(iconPath) ? iconPath : undefined;
}

const APP_WINDOW_ICON_PNG_PATH =
  resolveAppIconPath("messly-notification@128.png") ??
  resolveAppIconPath("messly-notification.png");
const APP_WINDOW_ICON_SVG_PATH = resolveAppIconPath("messly-icon.svg");
const APP_TRAY_ICON_SVG_PATH = resolveAppIconPath("messly-tray.svg");
const APP_WINDOW_ICON_ICO_PATH = fs.existsSync(APP_NOTIFICATION_ICON_ICO_PATH)
  ? APP_NOTIFICATION_ICON_ICO_PATH
  : undefined;

const MAIN_WINDOW_ICON_PATH = process.platform === "win32"
  ? APP_WINDOW_ICON_ICO_PATH ?? APP_WINDOW_ICON_PNG_PATH ?? APP_WINDOW_ICON_SVG_PATH
  : APP_WINDOW_ICON_PNG_PATH ?? APP_WINDOW_ICON_SVG_PATH;
const CHILD_WINDOW_ICON_PATH = MAIN_WINDOW_ICON_PATH;
const TRAY_ICON_PATH = process.platform === "win32"
  ? APP_WINDOW_ICON_ICO_PATH ?? APP_WINDOW_ICON_PNG_PATH ?? APP_TRAY_ICON_SVG_PATH ?? MAIN_WINDOW_ICON_PATH
  : APP_TRAY_ICON_SVG_PATH ?? APP_WINDOW_ICON_PNG_PATH ?? MAIN_WINDOW_ICON_PATH;

let r2Client = null;
let sharpModule = null;
let s3SdkModule = null;
let s3PresignerModule = null;
let profileMediaProcessors = null;
let spotifyPresenceFactory = null;
let backendEnvCache = null;
let appUpdater = null;
let mainWindowRef = null;
let appTray = null;
let trayIconImageCache = null;
let mainWindowIconImageCache = null;
let isAppQuitting = false;
let windowsBehaviorSettings = null;
let hiddenDirectMessagesState = null;
let secureAuthStorageState = null;
let statusPanelWindowRef = null;
let statusPanelMode = null;
let statusPanelMascotDataUrlCache = null;
let statusPanelRenderKey = null;
let mainWindowWaitingForFirstFrame = false;
let mainWindowFirstFrameReady = false;
let pendingSpotifyOAuthCallback = null;
const spotifyOAuthCallbackWaiters = new Set();
let spotifyPresenceService = null;
let embeddedDevToolsHostViewRef = null;
let notificationIconImageCache = undefined;
let startupAutoUpdatePromise = null;
let updaterAutoInstallInFlight = false;
let windowsHiddenForUpdateFlow = false;
let windowsFirewallBootstrapPromise = null;
const ephemeralSecureAuthStorage = new Map();
const hardenedWebContents = new WeakSet();
const hardenedSessions = new WeakSet();

function logNotificationDebug(event, details = {}) {
  if (!isDevEnvironment) {
    return;
  }
  console.debug(`[electron:notifications] ${event}`, details);
}

function getWindowsNotificationAppId() {
  const configured = String(process.env.MESSLY_WINDOWS_AUMID ?? WINDOWS_APP_USER_MODEL_ID ?? APP_NAME).trim();
  if (!configured) {
    return APP_NAME;
  }
  return configured;
}

const notificationNavigationCoordinator = new NotificationNavigationCoordinator({
  getMainWindow: () => getMainWindow(),
  createMainWindow: () => createMainWindow(),
  showMainWindow: () => showMainWindow(),
  ipcChannel: "notifications:open-conversation",
  debugLog: logNotificationDebug,
});
let notificationManager = null;

function getSharpModule() {
  if (!sharpModule) {
    sharpModule = require("sharp");
  }
  return sharpModule;
}

function getS3SdkModule() {
  if (!s3SdkModule) {
    s3SdkModule = require("@aws-sdk/client-s3");
  }
  return s3SdkModule;
}

function getS3PresignerModule() {
  if (!s3PresignerModule) {
    s3PresignerModule = require("@aws-sdk/s3-request-presigner");
  }
  return s3PresignerModule;
}

function getProfileMediaProcessors() {
  if (!profileMediaProcessors) {
    const { processAvatarUpload } = require("./media/avatarUpload.cjs");
    const { processBannerUpload } = require("./media/bannerUpload.cjs");
    profileMediaProcessors = { processAvatarUpload, processBannerUpload };
  }
  return profileMediaProcessors;
}

function getSpotifyPresenceFactory() {
  if (!spotifyPresenceFactory) {
    const loaded = require("./spotifyPresenceService.cjs");
    spotifyPresenceFactory = loaded.createSpotifyPresenceService;
  }
  return spotifyPresenceFactory;
}

function formatTransferBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  }
  const gb = mb / 1024;
  return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeOriginValue(rawValue) {
  try {
    const parsed = new URL(rawValue);
    if (parsed.protocol !== "https:") {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function getSecureAllowedNavigationOrigins() {
  const origins = new Set();
  for (const originValue of EXTRA_ALLOWED_HTTPS_ORIGINS) {
    const origin = normalizeOriginValue(originValue);
    if (origin) {
      origins.add(origin);
    }
  }
  if (!app.isPackaged) {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL || DEV_SERVER_URL;
    try {
      origins.add(new URL(rendererUrl).origin);
    } catch {}
    origins.add("http://localhost:5173");
    origins.add("http://127.0.0.1:5173");
  }
  return origins;
}

function isElectronInternalUrl(rawUrl) {
  const urlValue = String(rawUrl ?? "").toLowerCase();
  return (
    urlValue.startsWith("devtools://") ||
    urlValue.startsWith("chrome-devtools://") ||
    urlValue.startsWith("chrome-extension://")
  );
}

function isAllowedNavigationUrl(rawUrl) {
  const urlValue = String(rawUrl ?? "").trim();
  if (!urlValue) {
    return false;
  }
  if (isElectronInternalUrl(urlValue)) {
    return true;
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(urlValue);
  } catch {
    return false;
  }
  if (parsedUrl.protocol === "file:" || parsedUrl.protocol === "app:" || parsedUrl.protocol === "data:") {
    return true;
  }
  const allowedOrigins = getSecureAllowedNavigationOrigins();
  if (!app.isPackaged && (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:")) {
    return allowedOrigins.has(parsedUrl.origin);
  }
  if (parsedUrl.protocol === "https:") {
    return allowedOrigins.has(parsedUrl.origin);
  }
  return false;
}

function isTrustedPermissionRequestUrl(rawUrl) {
  const urlValue = String(rawUrl ?? "").trim();
  if (!urlValue) {
    return false;
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(urlValue);
  } catch {
    return false;
  }
  if (parsedUrl.protocol === "file:" || parsedUrl.protocol === "app:") {
    return true;
  }
  const allowedOrigins = getSecureAllowedNavigationOrigins();
  if (!app.isPackaged && (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:")) {
    return allowedOrigins.has(parsedUrl.origin);
  }
  if (parsedUrl.protocol === "https:") {
    return allowedOrigins.has(parsedUrl.origin);
  }
  return false;
}

function isDevToolsShortcutInput(input) {
  const key = String(input?.key ?? "").toLowerCase();
  const isF12 = key === "f12";
  const isCtrlShiftDevTools =
    Boolean(input?.control) && Boolean(input?.shift) && (key === "i" || key === "j");
  const isMacDevTools =
    Boolean(input?.meta) && Boolean(input?.alt) && (key === "i" || key === "j");
  return isF12 || isCtrlShiftDevTools || isMacDevTools;
}

function shouldApplyRendererCspHeader(details) {
  const rawUrl = String(details?.url ?? "").trim();
  if (!rawUrl || isElectronInternalUrl(rawUrl)) {
    return false;
  }

  const resourceType = String(details?.resourceType ?? "").trim().toLowerCase();
  if (resourceType && resourceType !== "mainframe" && resourceType !== "main_frame") {
    return false;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsedUrl.protocol === "file:" || parsedUrl.protocol === "app:") {
    return true;
  }

  if (!app.isPackaged && (parsedUrl.origin === "http://localhost:5173" || parsedUrl.origin === "http://127.0.0.1:5173")) {
    return true;
  }

  return false;
}

function applyWebContentsHardening(contents) {
  if (!contents || contents.isDestroyed() || hardenedWebContents.has(contents)) {
    return;
  }
  hardenedWebContents.add(contents);

  // Deny popup creation by default for every WebContents.
  if (typeof contents.setWindowOpenHandler === "function") {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
  }

  contents.on("will-navigate", (event, targetUrl) => {
    if (isAllowedNavigationUrl(targetUrl)) {
      return;
    }
    event.preventDefault();
  });

  if (app.isPackaged && !areDevToolsEnabled) {
    // In production, block DevTools accelerators and context inspect entrypoints.
    contents.on("before-input-event", (event, input) => {
      if (!isDevToolsShortcutInput(input)) {
        return;
      }
      event.preventDefault();
    });
    contents.on("devtools-opened", () => {
      try {
        if (!contents.isDestroyed() && contents.isDevToolsOpened()) {
          contents.closeDevTools();
        }
      } catch {}
    });
    contents.on("context-menu", (event, params) => {
      const inputFieldType = String(params?.inputFieldType ?? "").trim().toLowerCase();
      const isEditable = Boolean(params?.isEditable) || (inputFieldType && inputFieldType !== "none");
      if (isEditable) {
        return;
      }
      event.preventDefault();
    });
  }
}

function installSessionSecurityPolicies(targetSession) {
  if (!targetSession || hardenedSessions.has(targetSession)) {
    return;
  }
  hardenedSessions.add(targetSession);

  targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = String(details?.requestingUrl ?? webContents?.getURL?.() ?? "");
    const allowed =
      ALLOWED_APP_PERMISSIONS.includes(String(permission ?? "")) &&
      isTrustedPermissionRequestUrl(requestingUrl);
    callback(Boolean(allowed));
  });

  if (typeof targetSession.setPermissionCheckHandler === "function") {
    targetSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
      const sourceUrl = String(details?.requestingUrl ?? requestingOrigin ?? webContents?.getURL?.() ?? "");
      return (
        ALLOWED_APP_PERMISSIONS.includes(String(permission ?? "")) &&
        isTrustedPermissionRequestUrl(sourceUrl)
      );
    });
  }

  if (app.isPackaged) {
    // Inject strict CSP header on HTTP(S) responses in production.
    targetSession.webRequest.onHeadersReceived((details, callback) => {
      const responseHeaders = { ...(details.responseHeaders ?? {}) };
      if (shouldApplyRendererCspHeader(details)) {
        responseHeaders["Content-Security-Policy"] = [PRODUCTION_CONTENT_SECURITY_POLICY];
      }
      callback({ responseHeaders });
    });
  }
}

function applyEmbeddedDevToolsLayout(window) {
  if (!window || window.isDestroyed() || !embeddedDevToolsHostViewRef) {
    return;
  }
  const [contentWidth, contentHeight] = window.getContentSize();
  const unclampedWidth = Math.floor(contentWidth * EMBEDDED_DEVTOOLS_RIGHT_RATIO);
  const maxWidth = Math.floor(contentWidth * EMBEDDED_DEVTOOLS_MAX_WIDTH_RATIO);
  const panelWidth = clampNumber(unclampedWidth, EMBEDDED_DEVTOOLS_MIN_WIDTH_PX, maxWidth);
  embeddedDevToolsHostViewRef.setBounds({
    x: Math.max(0, contentWidth - panelWidth),
    y: 0,
    width: panelWidth,
    height: contentHeight,
  });
  embeddedDevToolsHostViewRef.setAutoResize({
    width: false,
    height: true,
    horizontal: false,
    vertical: true,
  });
}

function ensureEmbeddedDevToolsHost(window) {
  if (embeddedDevToolsHostViewRef && !embeddedDevToolsHostViewRef.webContents.isDestroyed()) {
    return embeddedDevToolsHostViewRef;
  }
  const hostView = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: areDevToolsEnabled,
    },
  });
  embeddedDevToolsHostViewRef = hostView;
  window.addBrowserView(hostView);
  applyEmbeddedDevToolsLayout(window);
  return hostView;
}

function destroyEmbeddedDevToolsHost(window) {
  if (!embeddedDevToolsHostViewRef) {
    return;
  }
  try {
    if (window && !window.isDestroyed()) {
      window.removeBrowserView(embeddedDevToolsHostViewRef);
    }
  } catch {}
  try {
    if (embeddedDevToolsHostViewRef.webContents && !embeddedDevToolsHostViewRef.webContents.isDestroyed()) {
      embeddedDevToolsHostViewRef.webContents.destroy();
    }
  } catch {}
  embeddedDevToolsHostViewRef = null;
}

function openEmbeddedDevTools(window) {
  if (!window || window.isDestroyed() || !areDevToolsEnabled) {
    return;
  }
  const targetWebContents = window.webContents;
  if (!targetWebContents || targetWebContents.isDestroyed()) {
    return;
  }
  if (!targetWebContents.isDevToolsOpened()) {
    targetWebContents.openDevTools({ mode: "right", activate: true });
    return;
  }
  targetWebContents.focus();
}

function getStatusPanelMascotDataUrl() {
  if (statusPanelMascotDataUrlCache !== null) {
    return statusPanelMascotDataUrlCache;
  }
  try {
    const imageBytes = fs.readFileSync(STATUS_PANEL_MASCOT_PATH);
    const mime = STATUS_PANEL_MASCOT_PATH.toLowerCase().endsWith(".svg") ? "image/svg+xml" : "image/png";
    statusPanelMascotDataUrlCache = `data:${mime};base64,${imageBytes.toString("base64")}`;
  } catch {
    statusPanelMascotDataUrlCache = "";
  }
  return statusPanelMascotDataUrlCache;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildStatusPanelHtml(payload) {
  const title = escapeHtml(payload?.title || "Carregando");
  const subtitle = escapeHtml(payload?.subtitle || "");
  const showSubtitle = Boolean(subtitle);
  const detail = escapeHtml(payload?.detail || "");
  const progressText = escapeHtml(payload?.progressText || "");
  const progressValue = Math.max(0, Math.min(100, Number(payload?.progressPercent ?? 0)));
  const showProgress = Boolean(payload?.showProgress);
  const showProgressBar = payload?.showProgressBar !== false;
  const mascotSrc = getStatusPanelMascotDataUrl();
  const hasFooter = Boolean(progressText || detail);

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Messly Status</title>

  <style>
    :root {
      color-scheme: dark;

      --bg: #1e1f22;
      --card: #313338;
      --text: #f2f3f5;
      --muted: #b5bac1;
      --border: rgba(255,255,255,.06);
      --radius: 12px;
    }

    * { box-sizing: border-box; }

    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      background: var(--bg);
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto;
      overflow: hidden;
      user-select: none;
    }

    .panel {
      width: 100%;
      height: 100%;
      background: var(--card);
      border-radius: var(--radius);
      border: 1px solid var(--border);
      display: grid;
      place-items: center;
      padding: 20px;
      -webkit-app-region: drag;
    }

    .center {
      display: grid;
      justify-items: center;
      gap: 12px;
      text-align: center;
    }

    /* Imagem sem corte e sem arredondamento */
    .avatar {
      width: 90px;
      height: 90px;

      border-radius: 0;        /* remove círculo */
      object-fit: contain;     /* mostra a imagem inteira */
      display: block;

      background: transparent;
    }

    .title {
      margin: 0;
      color: var(--text);
      font-size: 16px;
      font-weight: 600;
    }

    .subtitle {
      margin: 4px 0 0;
      color: var(--muted);
      font-size: 12px;
    }
  </style>
</head>

<body>
  <main class="panel">
    <section class="center">

      ${
        mascotSrc
          ? `<img class="avatar" src="${mascotSrc}" alt="">`
          : `<div style="width:90px;height:90px;"></div>`
      }

      <div>
        <p class="title">${title}</p>
        ${showSubtitle ? `<p class="subtitle">${subtitle}</p>` : ""}
      </div>

    </section>
  </main>
</body>
</html>`;
}

function buildStatusPanelHtmlV2(payload) {
  const title = escapeHtml(payload?.title || "Carregando");
  const subtitle = escapeHtml(payload?.subtitle || "");
  const showSubtitle = Boolean(subtitle);
  const detail = escapeHtml(payload?.detail || "");
  const progressText = escapeHtml(payload?.progressText || "");
  const progressValue = Math.max(0, Math.min(100, Number(payload?.progressPercent ?? 0)));
  const showProgress = Boolean(payload?.showProgress || progressText);
  const showProgressBar = payload?.showProgressBar !== false;
  const progressCounterRaw = String(payload?.progressCounterLabel ?? "").trim();
  const progressCounterLabel = escapeHtml(progressCounterRaw);
  const showProgressCounter = Boolean(progressCounterLabel);
  const mascotSrc = getStatusPanelMascotDataUrl();
  const hasFooter = Boolean(progressText || detail || showProgressBar || showProgressCounter);

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Messly Status</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #232831;
      --card: #232831;
      --text: #f4f7fb;
      --muted: #aeb8c8;
      --border: rgba(255,255,255,.08);
      --radius: 14px;
      --track: rgba(255,255,255,.14);
      --fill: linear-gradient(90deg, #ffffff 0%, #e9eef8 100%);
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      background: var(--bg);
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto;
      overflow: hidden;
      user-select: none;
    }
    .shell {
      width: 100%;
      height: 100%;
      display: grid;
      place-items: center;
      padding: 0;
    }
    .panel {
      width: 100%;
      min-height: 100%;
      border-radius: 0;
      border: 0;
      background: var(--card);
      box-shadow: none;
      padding: 16px 20px 14px;
      -webkit-app-region: drag;
      display: grid;
      grid-template-rows: 1fr auto;
    }
    .center {
      display: grid;
      justify-items: center;
      align-content: center;
      gap: 12px;
      text-align: center;
    }
    .avatar {
      width: 104px;
      height: 104px;
      border-radius: 0;
      object-fit: contain;
      display: block;
      background: transparent;
      filter: drop-shadow(0 8px 14px rgba(0,0,0,.35));
    }
    .title {
      margin: 0;
      color: var(--text);
      font-size: 24px;
      line-height: 1.1;
      font-weight: 800;
      letter-spacing: -0.02em;
    }
    .subtitle {
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.35;
      max-width: 35ch;
    }
    .footer {
      margin-top: 12px;
      display: grid;
      gap: 8px;
      justify-items: stretch;
      opacity: ${hasFooter ? "1" : "0"};
      transition: opacity 160ms ease;
    }
    .counter-row {
      display: flex;
      justify-content: flex-end;
      min-height: 18px;
    }
    .counter-chip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,.12);
      background: rgba(255,255,255,.04);
      color: rgba(235, 242, 251, .9);
      font-size: 12px;
      font-weight: 700;
      line-height: 1;
      min-width: 52px;
      height: 22px;
      padding: 0 9px;
      letter-spacing: .02em;
    }
    .progress-track {
      height: 8px;
      border-radius: 999px;
      background: var(--track);
      overflow: hidden;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.04);
    }
    .progress-fill {
      width: ${progressValue}%;
      height: 100%;
      border-radius: 999px;
      background: var(--fill);
      transition: width 180ms linear;
      box-shadow: 0 0 12px rgba(255,255,255,.35);
    }
    .progress-text {
      margin: 0;
      color: #eef3fb;
      font-size: 13px;
      line-height: 1.3;
      font-weight: 600;
      text-align: left;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .detail {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
      text-align: left;
      min-height: 16px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="panel">
      <section class="center">
        ${
          mascotSrc
            ? `<img class="avatar" src="${mascotSrc}" alt="">`
            : `<div style="width:88px;height:88px;"></div>`
        }
        <div>
          <p class="title">${title}</p>
          ${showSubtitle ? `<p class="subtitle">${subtitle}</p>` : ""}
        </div>
      </section>
      <section class="footer">
        ${showProgressCounter ? `<div class="counter-row"><span class="counter-chip">${progressCounterLabel}</span></div>` : ""}
        ${showProgressBar ? `<div class="progress-track"><div class="progress-fill"></div></div>` : ""}
        ${showProgress ? `<p class="progress-text">${progressText || `${Math.round(progressValue)}%`}</p>` : ""}
        ${detail ? `<p class="detail">${detail}</p>` : ""}
      </section>
    </section>
  </main>
</body>
</html>`;
}

function getStatusPanelWindow() {
  if (statusPanelWindowRef && !statusPanelWindowRef.isDestroyed()) {
    return statusPanelWindowRef;
  }

  const window = new BrowserWindow({
    width: 360,
    height: 380,
    minWidth: 360,
    minHeight: 380,
    maxWidth: 360,
    maxHeight: 380,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: false,
    backgroundColor: "#232831",
    roundedCorners: true,
    movable: true,
    focusable: true,
    autoHideMenuBar: true,
    title: "",
    icon: CHILD_WINDOW_ICON_PATH || MAIN_WINDOW_ICON_PATH,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: false,
    },
  });

  if (typeof window.setMenu === "function") {
    window.setMenu(null);
  }
  if (typeof window.removeMenu === "function") {
    window.removeMenu();
  }
  window.setMenuBarVisibility(false);

  window.on("closed", () => {
    if (statusPanelWindowRef === window) {
      statusPanelWindowRef = null;
      statusPanelMode = null;
      statusPanelRenderKey = null;
    }
  });

  statusPanelWindowRef = window;
  return window;
}

function showStatusPanel(payload, mode = "generic") {
  const panelWindow = getStatusPanelWindow();
  const normalizedMode = String(mode ?? "generic");
  const sourcePayload =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : {};
  const safePayload = {
    title: String(sourcePayload.title ?? "").trim(),
    subtitle: String(sourcePayload.subtitle ?? "").trim(),
    detail: String(sourcePayload.detail ?? "").trim(),
    progressText: String(sourcePayload.progressText ?? "").trim(),
    progressPercent: Number(sourcePayload.progressPercent ?? 0),
    showProgressBar: sourcePayload.showProgressBar !== false,
    showProgress: Boolean(sourcePayload.showProgress),
    progressCounterLabel: String(sourcePayload.progressCounterLabel ?? "").trim(),
  };

  if (normalizedMode === "startup") {
    if (!safePayload.title) {
      safePayload.title = "Iniciando Messly";
    }
    safePayload.subtitle = "";
    safePayload.detail = "";
    if (!safePayload.progressText) {
      safePayload.progressText = "Inicializando modulos";
    }
    if (!Number.isFinite(safePayload.progressPercent) || safePayload.progressPercent <= 0) {
      safePayload.progressPercent = 34;
    }
    safePayload.progressCounterLabel = "";
    safePayload.showProgressBar = true;
    safePayload.showProgress = true;
  } else if (normalizedMode === "update-check") {
    if (!safePayload.title) {
      safePayload.title = "Verificando atualização";
    }
    if (!safePayload.subtitle) {
      safePayload.subtitle = "Buscando nova versão...";
    }
    if (!safePayload.detail) {
      safePayload.detail = `Versão atual v${String(app.getVersion?.() ?? "0.0.0")}`;
    }
    if (!safePayload.progressText) {
      safePayload.progressText = "Consultando servidor de atualização";
    }
    if (!Number.isFinite(safePayload.progressPercent) || safePayload.progressPercent <= 0) {
      safePayload.progressPercent = 24;
    }
    if (!safePayload.progressCounterLabel) {
      safePayload.progressCounterLabel = "3/10";
    }
    safePayload.showProgressBar = true;
    safePayload.showProgress = true;
  } else if (normalizedMode === "update-download") {
    if (!safePayload.title) {
      safePayload.title = "Baixando atualização";
    }
    if (!safePayload.subtitle) {
      safePayload.subtitle = "Transferindo pacote para instalação";
    }
    if (!safePayload.progressText) {
      safePayload.progressText = "Preparando transferência";
    }
    if (!Number.isFinite(safePayload.progressPercent)) {
      safePayload.progressPercent = 0;
    }
    if (!safePayload.progressCounterLabel) {
      safePayload.progressCounterLabel = "7/10";
    }
    safePayload.showProgressBar = true;
    safePayload.showProgress = true;
  } else if (normalizedMode === "update-install") {
    if (!safePayload.title) {
      safePayload.title = "Aplicando atualização";
    }
    if (!safePayload.subtitle) {
      safePayload.subtitle = "Finalizando instalação...";
    }
    if (!safePayload.progressText) {
      safePayload.progressText = "Reiniciando o aplicativo";
    }
    if (!Number.isFinite(safePayload.progressPercent) || safePayload.progressPercent <= 0) {
      safePayload.progressPercent = 100;
    }
    if (!safePayload.progressCounterLabel) {
      safePayload.progressCounterLabel = "10/10";
    }
    safePayload.showProgressBar = true;
    safePayload.showProgress = true;
  }

  safePayload.progressPercent = Math.max(0, Math.min(100, Number(safePayload.progressPercent ?? 0)));

  const nextRenderKey = JSON.stringify({
    mode: normalizedMode,
    ...safePayload,
  });

  if (
    statusPanelMode === normalizedMode &&
    statusPanelRenderKey === nextRenderKey &&
    !panelWindow.isDestroyed() &&
    panelWindow.webContents &&
    !panelWindow.webContents.isDestroyed()
  ) {
    if (!panelWindow.isVisible()) {
      panelWindow.show();
    }
    return;
  }

  statusPanelMode = normalizedMode;
  statusPanelRenderKey = nextRenderKey;
  const html = buildStatusPanelHtmlV2(safePayload);
  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

  if (panelWindow.isDestroyed()) {
    return;
  }

  if (panelWindow.webContents && !panelWindow.webContents.isDestroyed()) {
    void panelWindow.loadURL(dataUrl).catch(() => {});
  }

  if (!panelWindow.isVisible()) {
    panelWindow.once("ready-to-show", () => {
      if (!panelWindow.isDestroyed()) {
        panelWindow.show();
      }
    });
  } else {
    panelWindow.show();
  }
}

function hideStatusPanel(options = {}) {
  const mode = typeof options === "string" ? options : options?.mode;
  const panelWindow = statusPanelWindowRef;
  if (!panelWindow || panelWindow.isDestroyed()) {
    statusPanelWindowRef = null;
    statusPanelMode = null;
    statusPanelRenderKey = null;
    return;
  }
  if (mode && statusPanelMode && statusPanelMode !== mode) {
    return;
  }
  statusPanelMode = null;
  statusPanelRenderKey = null;
  panelWindow.destroy();
}

function syncStatusPanelWithUpdaterState(nextState) {
  if (!nextState || typeof nextState !== "object") {
    return;
  }
  if (statusPanelMode === "startup") {
    return;
  }

  if (nextState.status === "checking") {
    if (statusPanelMode !== "update-check") {
      showStatusPanel(
        {
          title: "Checando atualizações",
          subtitle: "",
          detail: "",
          progressText: "",
          showProgressBar: false,
          showProgress: false,
        },
        "update-check",
      );
    }
    return;
  }

  if (nextState.status === "downloading") {
    if (statusPanelMode !== "update-download") {
      showStatusPanel(
        {
          title: "Baixando atualização",
          subtitle: "",
          detail: `v${String(nextState.currentVersion ?? app.getVersion?.() ?? "0.0.0")}`,
          progressText: "Baixando...",
          progressPercent: 18,
          showProgress: false,
        },
        "update-download",
      );
    }
    return;
  }

  if (nextState.status === "downloaded") {
    hideStatusPanel({ mode: "update-check" });
    hideStatusPanel({ mode: "update-download" });
    return;
  }

  if (nextState.status === "available" || nextState.status === "unavailable" || nextState.status === "error" || nextState.status === "disabled") {
    hideStatusPanel({ mode: "update-check" });
    hideStatusPanel({ mode: "update-download" });
  }
}

function syncStatusPanelWithUpdaterStateV2(nextState) {
  if (!nextState || typeof nextState !== "object") {
    return;
  }
  if (statusPanelMode === "startup") {
    return;
  }

  const status = String(nextState.status ?? "").trim().toLowerCase();
  if (status === "checking") {
    hideStatusPanel({ mode: "update-check" });
    return;
  }

  if (status === "downloading") {
    const downloadedBytes = Number(nextState.downloadedBytes ?? 0);
    const totalBytes = Number(nextState.totalBytes ?? 0);
    const progressPercent = Math.max(0, Math.min(100, Number(nextState.progressPercent ?? 0)));
    const progressLine = `${Math.round(progressPercent)}% - ${formatTransferBytes(downloadedBytes)} / ${formatTransferBytes(totalBytes)}`;
    const detailParts = [
      nextState.latestVersion ? `v${String(nextState.currentVersion ?? app.getVersion?.() ?? "0.0.0")} -> v${String(nextState.latestVersion)}` : "",
      String(nextState.assetName ?? "").trim(),
    ].filter(Boolean);

    showStatusPanel(
      {
        title: "Baixando atualização",
        subtitle: "Transferindo pacote para instalação",
        detail: detailParts.join(" - "),
        progressText: progressLine,
        progressPercent,
        showProgressBar: true,
        showProgress: true,
        progressCounterLabel: "7/10",
      },
      "update-download",
    );
    updaterAutoInstallInFlight = false;
    hideWindowsForUpdateFlow();
    return;
  }

  if (status === "downloaded") {
    showStatusPanel(
      {
        title: "Aplicando atualização",
        subtitle: "Finalizando instalação...",
        detail: nextState.latestVersion ? `Instalando versão v${String(nextState.latestVersion)}` : "",
        progressText: "Reiniciando o Messly para concluir",
        progressPercent: 100,
        showProgressBar: true,
        showProgress: true,
        progressCounterLabel: "10/10",
      },
      "update-install",
    );
    hideWindowsForUpdateFlow();

    if (updaterAutoInstallInFlight || !appUpdater?.installUpdate) {
      return;
    }

    updaterAutoInstallInFlight = true;
    void appUpdater.installUpdate()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error ?? "Falha desconhecida.");
        updaterAutoInstallInFlight = false;
        showStatusPanel(
          {
            title: "Falha ao aplicar atualização",
            subtitle: "Não foi possível concluir a instalação.",
            detail: message,
            progressText: "Tente novamente em alguns instantes.",
            progressPercent: 0,
            showProgressBar: false,
            showProgress: true,
            progressCounterLabel: "",
          },
          "update-install",
        );
        restoreWindowsAfterUpdateFlow();
      })
      .finally(() => {
        updaterAutoInstallInFlight = false;
      });
    return;
  }

  if (status === "available" || status === "unavailable" || status === "error" || status === "disabled" || status === "idle") {
    updaterAutoInstallInFlight = false;
    hideStatusPanel({ mode: "update-check" });
    hideStatusPanel({ mode: "update-download" });
    hideStatusPanel({ mode: "update-install" });
    restoreWindowsAfterUpdateFlow();
  }
}

function trimTransparentEdges(image) {
  if (!image || image.isEmpty()) {
    return image;
  }

  try {
    const size = image.getSize();
    const width = Number(size?.width ?? 0);
    const height = Number(size?.height ?? 0);
    if (width <= 0 || height <= 0) {
      return image;
    }

    const bitmap = image.toBitmap();
    if (!bitmap || bitmap.length < width * height * 4) {
      return image;
    }

    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixelOffset = (y * width + x) * 4;
        const alpha = bitmap[pixelOffset + 3] ?? 0;
        if (alpha <= 8) {
          continue;
        }
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }

    if (maxX < minX || maxY < minY) {
      return image;
    }

    const cropWidth = Math.max(1, maxX - minX + 1);
    const cropHeight = Math.max(1, maxY - minY + 1);
    if (cropWidth === width && cropHeight === height) {
      return image;
    }

    return image.crop({
      x: minX,
      y: minY,
      width: cropWidth,
      height: cropHeight,
    });
  } catch {
    return image;
  }
}

async function buildIconImage(iconPath, size) {
  if (!iconPath) {
    return null;
  }

  const ext = path.extname(iconPath).toLowerCase();
  if (ext === ".svg") {
    try {
      const svgBuffer = await fs.promises.readFile(iconPath);
      const sharp = getSharpModule();
      const pngBuffer = await sharp(svgBuffer)
        .resize({ width: size, height: size, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
      const svgImage = nativeImage.createFromBuffer(pngBuffer);
      if (!svgImage.isEmpty()) {
        if (process.platform === "win32") {
          const trimmed = trimTransparentEdges(svgImage);
          return trimmed.resize({ width: size, height: size, quality: "best" });
        }
        return svgImage.resize({ width: size, height: size });
      }
    } catch {
      // fall through to native load
    }
  }

  const baseIcon = nativeImage.createFromPath(iconPath);
  if (baseIcon.isEmpty()) {
    return null;
  }

  if (process.platform !== "win32") {
    return baseIcon;
  }

  const trimmed = trimTransparentEdges(baseIcon);
  return trimmed.resize({ width: size, height: size, quality: "best" });
}

async function buildTrayIconImage(iconPath) {
  return buildIconImage(iconPath, 24);
}

async function buildWindowIconImage(iconPath) {
  return buildIconImage(iconPath, 256);
}

async function buildNotificationIconImage(iconPath) {
  return buildIconImage(iconPath, WINDOWS_NOTIFICATION_ICON_SIZE);
}

async function prepareIconImages() {
  mainWindowIconImageCache = await buildWindowIconImage(MAIN_WINDOW_ICON_PATH ?? TRAY_ICON_PATH);
  trayIconImageCache = await buildTrayIconImage(TRAY_ICON_PATH ?? MAIN_WINDOW_ICON_PATH);
  const notificationIconSource = fs.existsSync(APP_NOTIFICATION_ICON_PNG_PATH)
    ? APP_NOTIFICATION_ICON_PNG_PATH
    : APP_NOTIFICATION_ICON_ICO_PATH;
  notificationIconImageCache = await buildNotificationIconImage(
    notificationIconSource ?? MAIN_WINDOW_ICON_PATH ?? TRAY_ICON_PATH,
  );
  if (!notificationIconImageCache && trayIconImageCache) {
    notificationIconImageCache =
      process.platform === "win32"
        ? trimTransparentEdges(trayIconImageCache).resize({
            width: WINDOWS_NOTIFICATION_ICON_SIZE,
            height: WINDOWS_NOTIFICATION_ICON_SIZE,
            quality: "best",
          })
        : trayIconImageCache;
  }
}

function clampBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

function getWindowsBehaviorSettingsPath() {
  return path.join(app.getPath("userData"), WINDOWS_BEHAVIOR_SETTINGS_FILE);
}

function normalizeWindowsBehaviorSettings(rawSettings) {
  const source =
    rawSettings && typeof rawSettings === "object" && !Array.isArray(rawSettings)
      ? rawSettings
      : {};
  return {
    startMinimized: clampBoolean(source.startMinimized, DEFAULT_WINDOWS_BEHAVIOR_SETTINGS.startMinimized),
    closeToTray: clampBoolean(source.closeToTray, DEFAULT_WINDOWS_BEHAVIOR_SETTINGS.closeToTray),
    launchAtStartup: clampBoolean(source.launchAtStartup, DEFAULT_WINDOWS_BEHAVIOR_SETTINGS.launchAtStartup),
  };
}

function readWindowsBehaviorSettingsFromDisk() {
  try {
    const filePath = getWindowsBehaviorSettingsPath();
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw) {
      return null;
    }
    return normalizeWindowsBehaviorSettings(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeWindowsBehaviorSettingsToDisk(nextSettings) {
  try {
    const filePath = getWindowsBehaviorSettingsPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(nextSettings, null, 2), "utf8");
  } catch {}
}

function readLaunchAtStartupFromSystem() {
  try {
    if (process.platform !== "win32" || typeof app.getLoginItemSettings !== "function") {
      return false;
    }
    const loginSettings = app.getLoginItemSettings();
    return Boolean(loginSettings?.openAtLogin);
  } catch {
    return false;
  }
}

function loadWindowsBehaviorSettings() {
  if (windowsBehaviorSettings) {
    return windowsBehaviorSettings;
  }

  const persisted = readWindowsBehaviorSettingsFromDisk();
  windowsBehaviorSettings = normalizeWindowsBehaviorSettings({
    ...DEFAULT_WINDOWS_BEHAVIOR_SETTINGS,
    ...(persisted ?? {}),
    launchAtStartup: persisted?.launchAtStartup ?? readLaunchAtStartupFromSystem(),
  });
  return windowsBehaviorSettings;
}

function syncLaunchAtStartupToSystem(enabled) {
  if (process.platform !== "win32") {
    return;
  }
  try {
    if (typeof app.setLoginItemSettings !== "function") {
      return;
    }
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: process.execPath,
      args: loadWindowsBehaviorSettings().startMinimized ? [START_MINIMIZED_ARG] : [],
    });
  } catch {}
}

function shouldStartMinimizedThisLaunch() {
  if (!loadWindowsBehaviorSettings().startMinimized) {
    return false;
  }
  return process.argv.some((arg) => String(arg).trim().toLowerCase() === START_MINIMIZED_ARG);
}

function setWindowsBehaviorSettings(nextPartial) {
  const current = loadWindowsBehaviorSettings();
  const next = normalizeWindowsBehaviorSettings({
    ...current,
    ...nextPartial,
  });
  windowsBehaviorSettings = next;
  syncLaunchAtStartupToSystem(next.launchAtStartup);
  writeWindowsBehaviorSettingsToDisk(next);
  return { ...next };
}

function getHiddenDirectMessagesStatePath() {
  return path.join(app.getPath("userData"), HIDDEN_DIRECT_MESSAGES_STATE_FILE);
}

function getSecureAuthStoragePath() {
  return path.join(app.getPath("userData"), SECURE_AUTH_STORAGE_FILE);
}

function normalizeSecureAuthStorageState(rawState) {
  const source =
    rawState && typeof rawState === "object" && !Array.isArray(rawState)
      ? rawState
      : {};
  const rawItems =
    source.items && typeof source.items === "object" && !Array.isArray(source.items)
      ? source.items
      : {};
  const items = {};

  for (const [keyRaw, valueRaw] of Object.entries(rawItems)) {
    const key = String(keyRaw ?? "").trim();
    const value = typeof valueRaw === "string" ? valueRaw.trim() : "";
    if (!SECURE_AUTH_STORAGE_KEY_REGEX.test(key) || !value) {
      continue;
    }
    items[key] = value;
  }

  return {
    version: 1,
    items,
  };
}

function readSecureAuthStorageFromDisk() {
  try {
    const filePath = getSecureAuthStoragePath();
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw) {
      return null;
    }

    return normalizeSecureAuthStorageState(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeSecureAuthStorageToDisk(nextState) {
  try {
    const filePath = getSecureAuthStoragePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(nextState, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
  } catch {}
}

function loadSecureAuthStorageState() {
  if (secureAuthStorageState) {
    return secureAuthStorageState;
  }

  const persisted = readSecureAuthStorageFromDisk();
  secureAuthStorageState = normalizeSecureAuthStorageState({
    version: 1,
    ...(persisted ?? {}),
  });
  return secureAuthStorageState;
}

function canPersistSecureAuthStorage() {
  try {
    return Boolean(safeStorage?.isEncryptionAvailable?.());
  } catch {
    return false;
  }
}

function encryptSecureAuthStorageValue(value) {
  if (!canPersistSecureAuthStorage()) {
    return null;
  }

  try {
    const encrypted = safeStorage.encryptString(String(value ?? ""));
    return Buffer.from(encrypted).toString("base64");
  } catch {
    return null;
  }
}

function decryptSecureAuthStorageValue(rawEncrypted) {
  const encrypted = typeof rawEncrypted === "string" ? rawEncrypted.trim() : "";
  if (!encrypted || !canPersistSecureAuthStorage()) {
    return null;
  }

  try {
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  } catch {
    return null;
  }
}

function normalizeSecureAuthStorageKey(rawKey) {
  const key = String(rawKey ?? "").trim();
  if (!SECURE_AUTH_STORAGE_KEY_REGEX.test(key)) {
    return null;
  }
  return key;
}

function getSecureAuthStorageValue(rawKey) {
  const key = normalizeSecureAuthStorageKey(rawKey);
  if (!key) {
    return null;
  }

  if (!canPersistSecureAuthStorage()) {
    return ephemeralSecureAuthStorage.get(key) ?? null;
  }

  const state = loadSecureAuthStorageState();
  return decryptSecureAuthStorageValue(state.items[key] ?? null);
}

function setSecureAuthStorageValue(rawKey, rawValue) {
  const key = normalizeSecureAuthStorageKey(rawKey);
  if (!key) {
    throw new Error("Invalid secure storage key.");
  }

  const value = String(rawValue ?? "");
  if (!canPersistSecureAuthStorage()) {
    ephemeralSecureAuthStorage.set(key, value);
    return { stored: true, persistent: false };
  }

  const encrypted = encryptSecureAuthStorageValue(value);
  if (!encrypted) {
    throw new Error("Failed to encrypt secure storage value.");
  }

  const state = loadSecureAuthStorageState();
  state.items[key] = encrypted;
  writeSecureAuthStorageToDisk(state);
  return { stored: true, persistent: true };
}

function removeSecureAuthStorageValue(rawKey) {
  const key = normalizeSecureAuthStorageKey(rawKey);
  if (!key) {
    return { removed: false, persistent: canPersistSecureAuthStorage() };
  }

  if (!canPersistSecureAuthStorage()) {
    const removed = ephemeralSecureAuthStorage.delete(key);
    return { removed, persistent: false };
  }

  const state = loadSecureAuthStorageState();
  const existed = Object.prototype.hasOwnProperty.call(state.items, key);
  if (existed) {
    delete state.items[key];
    writeSecureAuthStorageToDisk(state);
  }
  return { removed: existed, persistent: true };
}

function normalizeHiddenDirectMessageConversationIds(ids) {
  if (!Array.isArray(ids)) {
    return [];
  }

  return Array.from(
    new Set(
      ids
        .map((id) => String(id ?? "").trim())
        .filter(Boolean),
    ),
  );
}

function normalizeHiddenDirectMessageScopes(scopes) {
  if (!Array.isArray(scopes)) {
    return [];
  }

  return Array.from(
    new Set(
      scopes
        .map((scope) => String(scope ?? "").trim())
        .filter(Boolean),
    ),
  );
}

function normalizeHiddenDirectMessagesState(rawState) {
  const source =
    rawState && typeof rawState === "object" && !Array.isArray(rawState)
      ? rawState
      : {};
  const rawMap =
    source.hiddenConversationIdsByScope &&
    typeof source.hiddenConversationIdsByScope === "object" &&
    !Array.isArray(source.hiddenConversationIdsByScope)
      ? source.hiddenConversationIdsByScope
      : {};
  const hiddenConversationIdsByScope = {};

  for (const [scopeRaw, idsRaw] of Object.entries(rawMap)) {
    const scope = String(scopeRaw ?? "").trim();
    if (!scope) {
      continue;
    }

    hiddenConversationIdsByScope[scope] = normalizeHiddenDirectMessageConversationIds(idsRaw);
  }

  return {
    version: DEFAULT_HIDDEN_DIRECT_MESSAGES_STATE.version,
    hiddenConversationIdsByScope,
  };
}

function readHiddenDirectMessagesStateFromDisk() {
  try {
    const filePath = getHiddenDirectMessagesStatePath();
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw) {
      return null;
    }

    return normalizeHiddenDirectMessagesState(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeHiddenDirectMessagesStateToDisk(nextState) {
  try {
    const filePath = getHiddenDirectMessagesStatePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(nextState, null, 2), "utf8");
  } catch {}
}

function loadHiddenDirectMessagesState() {
  if (hiddenDirectMessagesState) {
    return hiddenDirectMessagesState;
  }

  const persisted = readHiddenDirectMessagesStateFromDisk();
  hiddenDirectMessagesState = normalizeHiddenDirectMessagesState({
    ...DEFAULT_HIDDEN_DIRECT_MESSAGES_STATE,
    ...(persisted ?? {}),
  });
  return hiddenDirectMessagesState;
}

function getHiddenDirectMessageConversationIds(scopes) {
  const normalizedScopes = normalizeHiddenDirectMessageScopes(scopes);
  if (normalizedScopes.length === 0) {
    return [];
  }

  const state = loadHiddenDirectMessagesState();
  const scopeMap =
    state.hiddenConversationIdsByScope &&
    typeof state.hiddenConversationIdsByScope === "object"
      ? state.hiddenConversationIdsByScope
      : {};

  for (const scope of normalizedScopes) {
    if (!Object.prototype.hasOwnProperty.call(scopeMap, scope)) {
      continue;
    }

    return normalizeHiddenDirectMessageConversationIds(scopeMap[scope]);
  }

  return [];
}

function setHiddenDirectMessageConversationIds(scopes, conversationIds) {
  const normalizedScopes = normalizeHiddenDirectMessageScopes(scopes);
  const normalizedConversationIds = normalizeHiddenDirectMessageConversationIds(conversationIds);
  const current = loadHiddenDirectMessagesState();
  const nextByScope = {
    ...(current.hiddenConversationIdsByScope ?? {}),
  };

  for (const scope of normalizedScopes) {
    if (normalizedConversationIds.length === 0) {
      delete nextByScope[scope];
      continue;
    }

    nextByScope[scope] = normalizedConversationIds;
  }

  hiddenDirectMessagesState = normalizeHiddenDirectMessagesState({
    ...current,
    hiddenConversationIdsByScope: nextByScope,
  });
  writeHiddenDirectMessagesStateToDisk(hiddenDirectMessagesState);
  return [...normalizedConversationIds];
}

function buildStartupSnapshot() {
  const refreshToken = String(getSecureAuthStorageValue(REFRESH_TOKEN_STORAGE_KEY) ?? "").trim();
  const hiddenState = loadHiddenDirectMessagesState();
  const scopeMap =
    hiddenState?.hiddenConversationIdsByScope && typeof hiddenState.hiddenConversationIdsByScope === "object"
      ? hiddenState.hiddenConversationIdsByScope
      : {};

  let hiddenConversationCount = 0;
  for (const conversationIds of Object.values(scopeMap)) {
    hiddenConversationCount += normalizeHiddenDirectMessageConversationIds(conversationIds).length;
  }

  return {
    generatedAt: new Date().toISOString(),
    appVersion: String(app.getVersion?.() ?? "0.0.0"),
    hasRefreshToken: Boolean(refreshToken),
    secureStorageAvailable: canPersistSecureAuthStorage(),
    windowsSettings: { ...loadWindowsBehaviorSettings() },
    apiConfig: {
      supabaseUrl: String(process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "").trim() || null,
      gatewayUrl: String(process.env.VITE_MESSLY_GATEWAY_URL ?? "").trim() || null,
      authApiUrl: String(process.env.VITE_MESSLY_AUTH_API_URL ?? "").trim() || null,
      appApiUrl: String(process.env.VITE_MESSLY_API_URL ?? "").trim() || null,
    },
    cacheHints: {
      hiddenScopeCount: Object.keys(scopeMap).length,
      hiddenConversationCount,
    },
  };
}

function getMainWindow() {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    return mainWindowRef;
  }
  mainWindowRef = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ?? null;
  return mainWindowRef;
}

function revealMainWindowAfterFirstFrame(options = {}) {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  const startMinimized =
    typeof options.startMinimized === "boolean" ? options.startMinimized : shouldStartMinimizedThisLaunch();

  mainWindowWaitingForFirstFrame = false;
  mainWindowFirstFrameReady = true;

  if (startMinimized) {
    if (loadWindowsBehaviorSettings().closeToTray) {
      void createAppTray();
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.minimize();
    }
    hideStatusPanel({ mode: "startup" });
    return true;
  }

  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  mainWindow.focus();
  hideStatusPanel({ mode: "startup" });
  return true;
}

function handleRendererFirstFrameReady(event, payload) {
  const senderWindow = BrowserWindow.fromWebContents(event.sender) ?? null;
  const mainWindow = getMainWindow();
  if (!senderWindow || !mainWindow || senderWindow !== mainWindow) {
    return;
  }

  if (mainWindowFirstFrameReady) {
    return;
  }

  revealMainWindowAfterFirstFrame({
    startMinimized: shouldStartMinimizedThisLaunch(),
    surface: payload?.surface,
  });
}

function showMainWindow() {
  if (mainWindowWaitingForFirstFrame && !mainWindowFirstFrameReady) {
    return false;
  }
  const window = getMainWindow();
  if (!window) {
    return false;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  if (!window.isVisible()) {
    window.show();
  }
  window.focus();
  return true;
}

function hideWindowsForUpdateFlow() {
  let hiddenAnyWindow = false;
  const windows = BrowserWindow.getAllWindows();
  for (const window of windows) {
    if (!window || window.isDestroyed()) {
      continue;
    }
    if (statusPanelWindowRef && window === statusPanelWindowRef) {
      continue;
    }
    try {
      window.hide();
      hiddenAnyWindow = true;
    } catch {}
  }
  if (hiddenAnyWindow) {
    windowsHiddenForUpdateFlow = true;
  }
}

function restoreWindowsAfterUpdateFlow() {
  if (!windowsHiddenForUpdateFlow) {
    return;
  }
  if (isAppQuitting) {
    return;
  }
  windowsHiddenForUpdateFlow = false;
  if (!showMainWindow()) {
    createMainWindow();
  }
}

function getMessageNotificationIcon() {
  if (notificationIconImageCache !== undefined) {
    return notificationIconImageCache;
  }

  const iconCandidates = [
    notificationIconImageCache,
    APP_NOTIFICATION_ICON_PNG_PATH,
    APP_NOTIFICATION_ICON_ICO_PATH,
    MAIN_WINDOW_ICON_PATH,
    CHILD_WINDOW_ICON_PATH,
    trayIconImageCache,
    resolveAppIconPath("messly-icon.svg"),
    process.execPath,
  ].filter(Boolean);

  for (const iconCandidate of iconCandidates) {
    try {
      if (typeof iconCandidate !== "string" && iconCandidate && !iconCandidate.isEmpty?.()) {
        notificationIconImageCache =
          process.platform === "win32"
            ? trimTransparentEdges(iconCandidate).resize({
                width: WINDOWS_NOTIFICATION_ICON_SIZE,
                height: WINDOWS_NOTIFICATION_ICON_SIZE,
                quality: "best",
              })
            : iconCandidate;
        return notificationIconImageCache;
      }
      const image = nativeImage.createFromPath(iconCandidate);
      if (image && !image.isEmpty()) {
        notificationIconImageCache =
          process.platform === "win32"
            ? trimTransparentEdges(image).resize({
                width: WINDOWS_NOTIFICATION_ICON_SIZE,
                height: WINDOWS_NOTIFICATION_ICON_SIZE,
                quality: "best",
              })
            : image;
        return notificationIconImageCache;
      }
    } catch {}
  }

  notificationIconImageCache = null;
  return notificationIconImageCache;
}

function getNotificationManager() {
  if (notificationManager) {
    return notificationManager;
  }

  notificationManager = createNotificationManager({
    app,
    appName: APP_NAME,
    appId: process.platform === "win32" ? getWindowsNotificationAppId() : APP_ID,
    NotificationCtor: Notification,
    nativeImage,
    navigationCoordinator: notificationNavigationCoordinator,
    getAppNotificationIcon: getMessageNotificationIcon,
    fetchImpl: global.fetch,
    debugLog: logNotificationDebug,
  });
  return notificationManager;
}

function queueConversationMessageNotification(payload) {
  return getNotificationManager().notifyMessage(payload);
}

async function notifyMessageHandler(_event, payload) {
  return queueConversationMessageNotification(payload);
}

function notificationsRendererReadyHandler(event) {
  if (!event || !event.sender || event.sender.isDestroyed?.()) {
    return;
  }
  const senderWindow = BrowserWindow.fromWebContents(event.sender) ?? null;
  const mainWindow = getMainWindow();
  if (!senderWindow || !mainWindow || senderWindow !== mainWindow) {
    return;
  }
  notificationNavigationCoordinator.markRendererReady(event.sender, true);
}

function extractSpotifyCallbackUrl(rawValue) {
  const candidate = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!candidate || !candidate.toLowerCase().startsWith(`${MESSLY_PROTOCOL_SCHEME}://`)) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (String(parsed.protocol ?? "").toLowerCase() !== `${MESSLY_PROTOCOL_SCHEME}:`) {
    return null;
  }

  if (String(parsed.host ?? "").toLowerCase() !== SPOTIFY_CALLBACK_HOST) {
    return null;
  }

  return parsed.toString();
}

function findSpotifyCallbackUrlInCommandLine(commandLine) {
  if (!Array.isArray(commandLine)) {
    return null;
  }
  for (const entry of commandLine) {
    const callbackUrl = extractSpotifyCallbackUrl(entry);
    if (callbackUrl) {
      return callbackUrl;
    }
  }
  return null;
}

function broadcastSpotifyOAuthCallback(payload) {
  const windows = BrowserWindow.getAllWindows();
  for (const window of windows) {
    if (window.isDestroyed()) {
      continue;
    }
    const webContents = window.webContents;
    if (!webContents || webContents.isDestroyed()) {
      continue;
    }
    webContents.send(SPOTIFY_OAUTH_CALLBACK_CHANNEL, payload);
  }
}

function notifySpotifyOAuthCallbackWaiters(payload) {
  if (!payload || typeof payload.url !== "string") {
    return;
  }
  for (const waiter of spotifyOAuthCallbackWaiters) {
    try {
      waiter(payload);
    } catch {}
  }
}

function storeSpotifyOAuthCallback(url) {
  pendingSpotifyOAuthCallback = {
    url,
    receivedAt: Date.now(),
  };
  broadcastSpotifyOAuthCallback(pendingSpotifyOAuthCallback);
  notifySpotifyOAuthCallbackWaiters(pendingSpotifyOAuthCallback);
}

function consumePendingSpotifyOAuthCallback(consume = true) {
  const pending = pendingSpotifyOAuthCallback;
  if (consume) {
    pendingSpotifyOAuthCallback = null;
  }
  return {
    url: pending?.url ?? null,
    receivedAt: typeof pending?.receivedAt === "number" ? pending.receivedAt : null,
  };
}

function extractSpotifyCallbackState(callbackUrl) {
  const value = typeof callbackUrl === "string" ? callbackUrl.trim() : "";
  if (!value) {
    return null;
  }
  try {
    const parsed = new URL(value);
    const state = parsed.searchParams.get("state");
    return typeof state === "string" && state.trim() ? state.trim() : "";
  } catch {
    return null;
  }
}

function waitForSpotifyOAuthCallback(options = {}) {
  const expectedState = typeof options.expectedState === "string" ? options.expectedState.trim() : "";
  const timeoutMs = Math.max(1_000, Number.parseInt(String(options.timeoutMs ?? ""), 10) || 3 * 60 * 1000);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId = null;
    let listener = null;

    const cleanup = () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (listener) {
        spotifyOAuthCallbackWaiters.delete(listener);
        listener = null;
      }
    };

    const matchesState = (callbackUrl) => {
      if (!expectedState) {
        return true;
      }
      return extractSpotifyCallbackState(callbackUrl) === expectedState;
    };

    const maybeResolve = (payload, consumePending = false) => {
      if (settled || !payload || typeof payload.url !== "string") {
        return false;
      }
      const callbackUrl = payload.url.trim();
      if (!callbackUrl || !matchesState(callbackUrl)) {
        return false;
      }
      if (consumePending) {
        consumePendingSpotifyOAuthCallback(true);
      }
      settled = true;
      cleanup();
      resolve({
        url: callbackUrl,
        receivedAt: typeof payload.receivedAt === "number" ? payload.receivedAt : Date.now(),
      });
      return true;
    };

    const pending = consumePendingSpotifyOAuthCallback(false);
    if (maybeResolve(pending, true)) {
      return;
    }

    listener = (payload) => {
      maybeResolve(payload, true);
    };
    spotifyOAuthCallbackWaiters.add(listener);
    timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error("Spotify OAuth callback timeout."));
    }, timeoutMs);
  });
}

function registerMesslyProtocolClient() {
  try {
    if (app.isPackaged) {
      app.setAsDefaultProtocolClient(MESSLY_PROTOCOL_SCHEME);
      return;
    }

    const appEntry = process.argv[1];
    if (appEntry) {
      app.setAsDefaultProtocolClient(MESSLY_PROTOCOL_SCHEME, process.execPath, [path.resolve(appEntry)]);
    }
  } catch {}
}

function refreshAppTrayMenu() {
  if (!appTray || appTray.isDestroyed?.()) {
    return;
  }
  const hasWindow = Boolean(getMainWindow());
  const menu = Menu.buildFromTemplate([
    {
      label: hasWindow ? "Abrir Messly" : "Abrir",
      click: () => {
        if (!showMainWindow()) {
          createMainWindow();
        }
      },
    },
    {
      label: "Verificar atualizações",
      enabled: Boolean(appUpdater?.checkForUpdates),
      click: () => {
        void appUpdater?.checkForUpdates?.().catch(() => {});
      },
    },
    { type: "separator" },
    {
      label: "Sair",
      click: () => {
        isAppQuitting = true;
        app.quit();
      },
    },
  ]);
  appTray.setContextMenu(menu);
}

async function createAppTray() {
  if (appTray && !appTray.isDestroyed?.()) {
    refreshAppTrayMenu();
    return appTray;
  }
  const trayIconPath = TRAY_ICON_PATH;
  if (!trayIconPath) {
    return null;
  }

  const trayIconImage = trayIconImageCache ?? (await buildTrayIconImage(trayIconPath));
  trayIconImageCache = trayIconImage ?? trayIconImageCache;
  const trayIcon = trayIconImage ?? nativeImage.createFromPath(trayIconPath);
  if (!trayIcon || trayIcon.isEmpty()) {
    return null;
  }

  appTray = new Tray(trayIcon);
  notificationIconImageCache = trayIcon;
  appTray.setToolTip("Messly");
  appTray.on("click", () => {
    if (!showMainWindow()) {
      createMainWindow();
    }
  });

  refreshAppTrayMenu();
  return appTray;
}

function destroyAppTray() {
  if (!appTray) {
    return;
  }
  try {
    appTray.destroy?.();
  } catch {}
  appTray = null;
}

function createDisabledUpdater(reason) {
  const state = {
    enabled: false,
    status: "disabled",
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
    errorMessage: reason || null,
  };
  let broadcast = () => {};
  const emit = () => {
    broadcast({ ...state });
  };
  return {
    getState: () => ({ ...state }),
    setBroadcaster: (nextBroadcaster) => {
      broadcast = typeof nextBroadcaster === "function" ? nextBroadcaster : () => {};
      emit();
    },
    checkForUpdates: async () => ({ ...state }),
    downloadUpdate: async () => {
      throw new Error(reason || "Atualizador desativado.");
    },
    installUpdate: async () => {
      throw new Error(reason || "Atualizador desativado.");
    },
    startAutoCheck: () => {},
    stopAutoCheck: () => {},
  };
}

function broadcastUpdaterState(nextState) {
  syncStatusPanelWithUpdaterStateV2(nextState);
  const windows = BrowserWindow.getAllWindows();
  for (const window of windows) {
    if (window.isDestroyed()) {
      continue;
    }
    const webContents = window.webContents;
    if (!webContents || webContents.isDestroyed()) {
      continue;
    }
    webContents.send("updater:state-changed", nextState);
  }
}

function readBooleanEnvFlag(rawValue, defaultValue = false) {
  const normalized = String(rawValue ?? "").trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function isFirewallVerboseLogsEnabled() {
  return isDevEnvironment || readBooleanEnvFlag(process.env.MESSLY_FIREWALL_VERBOSE_LOGS, false);
}

function createFirewallLogger() {
  return {
    debug: (...args) => {
      if (!isFirewallVerboseLogsEnabled()) {
        return;
      }
      console.debug(...args);
    },
    info: (...args) => {
      if (!isFirewallVerboseLogsEnabled()) {
        return;
      }
      console.info(...args);
    },
    warn: (...args) => {
      console.warn(...args);
    },
  };
}

function resolveWindowsFirewallProfile() {
  return String(process.env.MESSLY_FIREWALL_PROFILE ?? WINDOWS_FIREWALL_PROFILE).trim().toLowerCase() || DEFAULT_FIREWALL_PROFILE;
}

function isWindowsFirewallPublicProfileAllowed() {
  return readBooleanEnvFlag(process.env.MESSLY_FIREWALL_ALLOW_PUBLIC_PROFILE, false);
}

async function bootstrapWindowsFirewallRule() {
  if (process.platform !== "win32") {
    return null;
  }

  if (windowsFirewallBootstrapPromise) {
    return windowsFirewallBootstrapPromise;
  }

  const logger = createFirewallLogger();
  const executablePath = getInstalledExePath(app);

  windowsFirewallBootstrapPromise = ensureWindowsFirewallRule({
    ruleName: WINDOWS_FIREWALL_RULE_NAME,
    profile: resolveWindowsFirewallProfile(),
    allowPublicProfile: isWindowsFirewallPublicProfileAllowed(),
    executablePath,
    logger,
  })
    .then((result) => {
      if (String(result?.status ?? "") === "ready") {
        if (isFirewallVerboseLogsEnabled()) {
          logger.info("[firewall] bootstrap completed", result);
        }
        return result;
      }

      logger.warn("[firewall] bootstrap finished with non-ready status", result);
      return result;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error ?? "unknown");
      logger.warn(`[firewall] bootstrap failed: ${message}`);
      return null;
    });

  return windowsFirewallBootstrapPromise;
}

async function collectWindowsNetworkDiagnosticsSnapshot() {
  if (process.platform !== "win32") {
    return collectWindowsNetworkDiagnostics({
      ruleName: WINDOWS_FIREWALL_RULE_NAME,
      profile: resolveWindowsFirewallProfile(),
      executablePath: getInstalledExePath(app),
      allowPublicProfile: isWindowsFirewallPublicProfileAllowed(),
    });
  }

  return collectWindowsNetworkDiagnostics({
    ruleName: WINDOWS_FIREWALL_RULE_NAME,
    profile: resolveWindowsFirewallProfile(),
    executablePath: getInstalledExePath(app),
    allowPublicProfile: isWindowsFirewallPublicProfileAllowed(),
    logger: createFirewallLogger(),
  });
}

function createConfiguredAppUpdater() {
  const enableInDev = readBooleanEnvFlag(process.env.AUTO_UPDATE_ENABLE_IN_DEV, false);
  if (!app.isPackaged && !enableInDev) {
    return createDisabledUpdater("Atualizador desativado no modo desenvolvimento.");
  }

  const provider = String(process.env.MESSLY_UPDATER_PROVIDER ?? "electron-updater").trim().toLowerCase();
  const githubOwner = String(process.env.MESSLY_UPDATER_OWNER ?? "1blayze").trim() || "1blayze";
  const githubRepo = String(process.env.MESSLY_UPDATER_REPO ?? "Messly-updates").trim() || "Messly-updates";
  const githubToken =
    String(
      process.env.MESSLY_UPDATER_TOKEN ??
        process.env.GITHUB_TOKEN ??
        process.env.GH_TOKEN ??
        "",
    ).trim() || undefined;

  const createLegacyGithubUpdater = () =>
    createAppUpdater({
      app,
      shell,
      owner: githubOwner,
      repo: githubRepo,
      token: githubToken,
    });

  if (provider === "github-api" || provider === "legacy-github") {
    return createLegacyGithubUpdater();
  }

  try {
    return createElectronUpdaterAdapter({
      app,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "unknown");
    console.warn(`[updater] Failed to initialize electron-updater adapter: ${message}. Falling back to github-api updater.`);
    return createLegacyGithubUpdater();
  }
}

async function runStartupAutoUpdateIfEnabled() {
  if (startupAutoUpdatePromise) {
    return startupAutoUpdatePromise;
  }

  if (!app.isPackaged || !appUpdater) {
    return;
  }

  const autoInstallOnStartup = readBooleanEnvFlag(process.env.AUTO_UPDATE_INSTALL_ON_STARTUP, true);
  if (!autoInstallOnStartup) {
    return;
  }

  startupAutoUpdatePromise = (async () => {
    try {
      const checkedState = await appUpdater.checkForUpdates();
      const checkedStatus = String(
        checkedState?.status ??
          appUpdater?.getState?.()?.status ??
          "",
      )
        .trim()
        .toLowerCase();

      if (checkedStatus === "available") {
        await appUpdater.downloadUpdate();
      }

      const resolvedStatus = String(appUpdater?.getState?.()?.status ?? "")
        .trim()
        .toLowerCase();
      if (resolvedStatus !== "downloaded") {
        return;
      }

      showStatusPanel(
        {
          title: "Aplicando atualização",
          subtitle: "Reiniciando para concluir a instalação",
          detail: "",
          progressText: "Finalizando atualização",
          progressPercent: 100,
          showProgressBar: true,
          showProgress: true,
          progressCounterLabel: "10/10",
        },
        "update-install",
      );

      await appUpdater.installUpdate();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "unknown");
      console.warn(`[updater] Startup auto-update failed: ${message}`);
      hideStatusPanel({ mode: "update-check" });
      hideStatusPanel({ mode: "update-download" });
      hideStatusPanel({ mode: "update-install" });
    }
  })().finally(() => {
    startupAutoUpdatePromise = null;
  });

  return startupAutoUpdatePromise;
}

function getR2Client() {
  if (r2Client) {
    return r2Client;
  }

  const backendEnv = getResolvedBackendEnv();
  const { S3Client } = getS3SdkModule();

  r2Client = new S3Client({
    region: backendEnv.R2_REGION,
    endpoint: backendEnv.R2_ENDPOINT,
    forcePathStyle: backendEnv.R2_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: backendEnv.R2_ACCESS_KEY_ID,
      secretAccessKey: backendEnv.R2_SECRET_ACCESS_KEY,
    },
  });

  return r2Client;
}

function normalizeBinaryPayload(rawBytes) {
  if (Buffer.isBuffer(rawBytes)) {
    return rawBytes;
  }

  if (rawBytes instanceof ArrayBuffer) {
    return Buffer.from(rawBytes);
  }

  if (ArrayBuffer.isView(rawBytes)) {
    return Buffer.from(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  }

  if (Array.isArray(rawBytes)) {
    return Buffer.from(rawBytes);
  }

  throw new Error("Invalid binary payload.");
}

function isValidProfileUserId(value) {
  return typeof value === "string" && /^[a-z0-9-]{16,64}$/i.test(value);
}

function getR2Bucket() {
  return getResolvedBackendEnv().R2_BUCKET;
}

function getResolvedBackendEnv() {
  if (backendEnvCache) {
    return backendEnvCache;
  }
  backendEnvCache = getBackendEnv();
  return backendEnvCache;
}

function sanitizeMediaKey(rawKey) {
  if (typeof rawKey !== "string") {
    return null;
  }

  const normalized = rawKey.trim().replace(/^\/+/, "");
  if (!normalized) {
    return null;
  }

  if (normalized.includes("..") || normalized.includes("\\") || normalized.includes("//")) {
    return null;
  }

  if (!SAFE_MEDIA_KEY_REGEX.test(normalized)) {
    return null;
  }

  const hasAllowedPrefix = ALLOWED_MEDIA_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  if (!hasAllowedPrefix) {
    return null;
  }

  return normalized;
}

function normalizeSignedUrlTtl(rawValue) {
  const numericValue = Number(rawValue);
  if (!Number.isFinite(numericValue)) {
    return DEFAULT_SIGNED_URL_TTL_SECONDS;
  }

  const integerValue = Math.trunc(numericValue);
  return Math.max(MIN_SIGNED_URL_TTL_SECONDS, Math.min(MAX_SIGNED_URL_TTL_SECONDS, integerValue));
}

function sanitizeSuggestedDownloadFileName(rawValue, fallback = "arquivo") {
  const normalized = typeof rawValue === "string"
    ? rawValue
      .replace(/\u0000/g, "")
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
      .trim()
    : "";
  const collapsed = normalized.replace(/\s+/g, " ");
  return (collapsed || fallback).slice(0, 180);
}

function buildSaveDialogFilters(fileName) {
  const extension = path.extname(fileName).replace(/^\./, "").trim().toLowerCase();
  if (!extension || !/^[a-z0-9]{1,10}$/i.test(extension)) {
    return [{ name: "Todos os arquivos", extensions: ["*"] }];
  }
  return [
    { name: extension.toUpperCase(), extensions: [extension] },
    { name: "Todos os arquivos", extensions: ["*"] },
  ];
}

async function getSignedMediaUrlHandler(_event, payload) {
  const safeKey = sanitizeMediaKey(payload?.key);
  if (!safeKey) {
    throw new Error("Invalid media key.");
  }

  const expiresIn = normalizeSignedUrlTtl(payload?.expiresSeconds);
  const { GetObjectCommand } = getS3SdkModule();
  const { getSignedUrl } = getS3PresignerModule();
  const getObjectCommand = new GetObjectCommand({
    Bucket: getR2Bucket(),
    Key: safeKey,
  });

  const url = await getSignedUrl(getR2Client(), getObjectCommand, { expiresIn });
  return {
    url,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

async function uploadProfileMediaHandler(_event, payload) {
  const kind = payload?.kind;
  if (kind !== "avatar" && kind !== "banner") {
    throw createMediaUploadError("INVALID_IMAGE", {});
  }

  const userId = payload?.userId;
  if (!isValidProfileUserId(userId)) {
    throw new Error("Invalid user identifier.");
  }

  try {
    const binaryPayload = normalizeBinaryPayload(payload?.bytes);
    const { processAvatarUpload, processBannerUpload } = getProfileMediaProcessors();
    const processedAsset = kind === "avatar" ? await processAvatarUpload(binaryPayload) : await processBannerUpload(binaryPayload);

    const prefix = PROFILE_MEDIA_PREFIX_BY_KIND[kind];
    const key = `${prefix}/${userId}.${processedAsset.ext}`;

    const { PutObjectCommand } = getS3SdkModule();
    const command = new PutObjectCommand({
      Bucket: getR2Bucket(),
      Key: key,
      Body: processedAsset.buffer,
      ContentType: processedAsset.contentType,
      ContentLength: processedAsset.size,
      CacheControl: PROFILE_MEDIA_CACHE_CONTROL,
    });

    await getR2Client().send(command);

    return {
      key,
      hash: processedAsset.hash,
      size: processedAsset.size,
    };
  } catch (error) {
    if (isMediaUploadError(error)) {
      throw error;
    }

    if (error instanceof Error && error.message === "Invalid binary payload.") {
      throw createMediaUploadError("INVALID_IMAGE", {});
    }

    throw error;
  }
}

async function uploadAttachmentHandler(_event, payload) {
  const safeKey = sanitizeMediaKey(payload?.key);
  if (!safeKey || !safeKey.startsWith("attachments/")) {
    throw new Error("Invalid attachment key.");
  }

  const binaryPayload = normalizeBinaryPayload(payload?.bytes);
  const contentType =
    typeof payload?.contentType === "string" && payload.contentType.trim()
      ? payload.contentType.trim()
      : "application/octet-stream";

  const { PutObjectCommand } = getS3SdkModule();
  const command = new PutObjectCommand({
    Bucket: getR2Bucket(),
    Key: safeKey,
    Body: binaryPayload,
    ContentType: contentType,
    ContentLength: binaryPayload.length,
    CacheControl: PROFILE_MEDIA_CACHE_CONTROL,
  });

  await getR2Client().send(command);

  return {
    key: safeKey,
    size: binaryPayload.length,
  };
}

async function openExternalUrlHandler(_event, payload) {
  const url = typeof payload?.url === "string" ? payload.url.trim() : "";
  if (!/^(https?:\/\/|spotify:)/i.test(url)) {
    throw new Error("Invalid external url.");
  }

  await shell.openExternal(url);
  return { opened: true };
}

async function downloadRemoteFileHandler(event, payload) {
  const url = typeof payload?.url === "string" ? payload.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Invalid download url.");
  }

  const fallbackName = (() => {
    try {
      const parsed = new URL(url);
      return decodeURIComponent(parsed.pathname.split("/").pop() || "arquivo");
    } catch {
      return "arquivo";
    }
  })();

  const suggestedFileName = sanitizeSuggestedDownloadFileName(payload?.fileName, fallbackName || "arquivo");
  const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindowRef ?? null;
  const defaultPath = path.join(app.getPath("downloads"), suggestedFileName);
  const saveDialogResult = await dialog.showSaveDialog(parentWindow ?? undefined, {
    title: "Salvar como",
    defaultPath,
    buttonLabel: "Salvar",
    filters: buildSaveDialogFilters(suggestedFileName),
  });

  if (saveDialogResult.canceled || !saveDialogResult.filePath) {
    return {
      saved: false,
      canceled: true,
      filePath: null,
    };
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download media (${response.status}).`);
  }

  const binaryBody = Buffer.from(await response.arrayBuffer());
  await fs.promises.writeFile(saveDialogResult.filePath, binaryBody);

  return {
    saved: true,
    canceled: false,
    filePath: saveDialogResult.filePath,
  };
}

async function getScreenShareSourcesHandler(_event, options) {
  const requestedTypes = Array.isArray(options?.types)
    ? options.types.filter((item) => item === "screen" || item === "window")
    : [];
  const types = requestedTypes.length > 0 ? requestedTypes : ["screen", "window"];
  const thumbnailWidth = Number(options?.thumbnailSize?.width) || 320;
  const thumbnailHeight = Number(options?.thumbnailSize?.height) || 180;

  const sources = await desktopCapturer.getSources({
    types,
    thumbnailSize: {
      width: Math.max(0, Math.min(1024, thumbnailWidth)),
      height: Math.max(0, Math.min(1024, thumbnailHeight)),
    },
    fetchWindowIcons: Boolean(options?.fetchWindowIcons ?? true),
  });

  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    displayId: source.display_id ?? null,
    thumbnail: source.thumbnail ? source.thumbnail.toDataURL() : null,
    appIcon: source.appIcon ? source.appIcon.toDataURL() : null,
  }));
}

async function setWindowAttentionHandler(_event, payload) {
  const enabled = Boolean(payload?.enabled);
  const mainWindow = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ?? null;
  if (!mainWindow) {
    return { enabled: false };
  }
  mainWindow.flashFrame(enabled);
  return { enabled };
}

async function getPendingSpotifyOAuthCallbackHandler(_event, payload) {
  const consume = payload?.consume !== false;
  return consumePendingSpotifyOAuthCallback(consume);
}

function getSpotifyPresenceServiceOrThrow() {
  if (!spotifyPresenceService) {
    throw new Error("Spotify presence service unavailable.");
  }
  return spotifyPresenceService;
}

function registerIpcHandlers() {
  ipcMain.removeAllListeners("app:renderer-first-frame-ready");
  ipcMain.removeAllListeners("notifications:renderer-ready");
  ipcMain.removeHandler("media:get-signed-url");
  ipcMain.removeHandler("media:upload-profile");
  ipcMain.removeHandler("media:upload-attachment");
  ipcMain.removeHandler("media:download-remote-file");
  ipcMain.removeHandler("shell:open-external");
  ipcMain.removeHandler("screenshare:get-sources");
  ipcMain.removeHandler("window:set-attention");
  ipcMain.removeHandler("updater:get-state");
  ipcMain.removeHandler("updater:check");
  ipcMain.removeHandler("updater:download");
  ipcMain.removeHandler("updater:install");
  ipcMain.removeHandler("windows-settings:get");
  ipcMain.removeHandler("windows-settings:update");
  ipcMain.removeHandler("windows-settings:restore-window");
  ipcMain.removeHandler("windows-network:diagnostics");
  ipcMain.removeHandler("direct-messages:hidden:get");
  ipcMain.removeHandler("direct-messages:hidden:set");
  ipcMain.removeHandler("auth:storage:get");
  ipcMain.removeHandler("auth:storage:set");
  ipcMain.removeHandler("auth:storage:remove");
  ipcMain.removeHandler("auth:refresh-token:get");
  ipcMain.removeHandler("auth:refresh-token:set");
  ipcMain.removeHandler("auth:refresh-token:remove");
  ipcMain.removeHandler("app:get-startup-snapshot");
  ipcMain.removeHandler("spotify:get-pending-callback");
  ipcMain.removeHandler("spotify:presence:get-state");
  ipcMain.removeHandler("spotify:presence:connect");
  ipcMain.removeHandler("spotify:presence:disconnect");
  ipcMain.removeHandler("spotify:presence:set-visibility");
  ipcMain.removeHandler("spotify:presence:start");
  ipcMain.removeHandler("spotify:presence:stop");
  ipcMain.removeHandler("spotify:presence:poll-once");
  ipcMain.removeHandler("spotify:presence:debug-state");
  ipcMain.removeHandler("notifications:notify-message");
  ipcMain.handle("media:get-signed-url", getSignedMediaUrlHandler);
  ipcMain.handle("media:upload-profile", uploadProfileMediaHandler);
  ipcMain.handle("media:upload-attachment", uploadAttachmentHandler);
  ipcMain.handle("media:download-remote-file", downloadRemoteFileHandler);
  ipcMain.handle("shell:open-external", openExternalUrlHandler);
  ipcMain.handle("screenshare:get-sources", getScreenShareSourcesHandler);
  ipcMain.handle("window:set-attention", setWindowAttentionHandler);
  ipcMain.handle("updater:get-state", async () => appUpdater?.getState?.() ?? null);
  ipcMain.handle("updater:check", async () => {
    if (!appUpdater?.checkForUpdates) {
      throw new Error("Updater indisponível.");
    }
    showStatusPanel(
      {
        title: "Verificando atualização",
        subtitle: "",
        detail: "",
        progressText: "",
        showProgressBar: false,
        showProgress: false,
      },
      "update-check",
    );
    return appUpdater.checkForUpdates();
  });
  ipcMain.handle("updater:download", async () => {
    if (!appUpdater?.downloadUpdate) {
      throw new Error("Updater indisponível.");
    }
    showStatusPanel(
      {
        title: "Baixando atualização",
        subtitle: "Preparando download...",
        detail: `v${String(app.getVersion?.() ?? "0.0.0")}`,
        progressText: "Conectando ao servidor...",
        progressPercent: 2,
        showProgressBar: true,
        showProgress: true,
        progressCounterLabel: "7/10",
      },
      "update-download",
    );
    return appUpdater.downloadUpdate();
  });
  ipcMain.handle("updater:install", async () => {
    if (!appUpdater?.installUpdate) {
      throw new Error("Updater indisponível.");
    }
    showStatusPanel(
      {
        title: "Aplicando atualização",
        subtitle: "Finalizando instalação...",
        detail: `v${String(app.getVersion?.() ?? "0.0.0")}`,
        progressText: "Reiniciando o Messly para concluir",
        progressPercent: 100,
        showProgressBar: true,
        showProgress: true,
        progressCounterLabel: "10/10",
      },
      "update-install",
    );
    hideWindowsForUpdateFlow();
    updaterAutoInstallInFlight = true;
    try {
      return await appUpdater.installUpdate();
    } catch (error) {
      updaterAutoInstallInFlight = false;
      restoreWindowsAfterUpdateFlow();
      throw error;
    }
  });
  ipcMain.handle("windows-settings:get", async () => ({ ...loadWindowsBehaviorSettings() }));
  ipcMain.handle("windows-settings:update", async (_event, payload) => {
    return setWindowsBehaviorSettings(payload ?? {});
  });
  ipcMain.handle("windows-settings:restore-window", async () => {
    return { restored: showMainWindow() };
  });
  ipcMain.handle("windows-network:diagnostics", async () => {
    return collectWindowsNetworkDiagnosticsSnapshot();
  });
  ipcMain.handle("direct-messages:hidden:get", async (_event, payload) => {
    return {
      conversationIds: getHiddenDirectMessageConversationIds(payload?.scopes),
    };
  });
  ipcMain.handle("direct-messages:hidden:set", async (_event, payload) => {
    return {
      conversationIds: setHiddenDirectMessageConversationIds(payload?.scopes, payload?.conversationIds),
    };
  });
  ipcMain.handle("auth:storage:get", async (_event, payload) => {
    return {
      value: getSecureAuthStorageValue(payload?.key),
      persistent: canPersistSecureAuthStorage(),
    };
  });
  ipcMain.handle("auth:storage:set", async (_event, payload) => {
    return setSecureAuthStorageValue(payload?.key, payload?.value);
  });
  ipcMain.handle("auth:storage:remove", async (_event, payload) => {
    return removeSecureAuthStorageValue(payload?.key);
  });
  ipcMain.handle("auth:refresh-token:get", async () => {
    return getSecureAuthStorageValue(REFRESH_TOKEN_STORAGE_KEY);
  });
  ipcMain.handle("auth:refresh-token:set", async (_event, token) => {
    return setSecureAuthStorageValue(REFRESH_TOKEN_STORAGE_KEY, token);
  });
  ipcMain.handle("auth:refresh-token:remove", async () => {
    return removeSecureAuthStorageValue(REFRESH_TOKEN_STORAGE_KEY);
  });
  ipcMain.handle("app:get-startup-snapshot", async () => {
    return buildStartupSnapshot();
  });
  ipcMain.handle("spotify:get-pending-callback", getPendingSpotifyOAuthCallbackHandler);
  ipcMain.handle("spotify:presence:get-state", async (_event, payload) => {
    const service = getSpotifyPresenceServiceOrThrow();
    return service.getState(payload?.scope);
  });
  ipcMain.handle("spotify:presence:connect", async (_event, payload) => {
    const service = getSpotifyPresenceServiceOrThrow();
    return service.connect(payload?.scope, {
      clientId: payload?.clientId,
      redirectUri: payload?.redirectUri,
    });
  });
  ipcMain.handle("spotify:presence:disconnect", async (_event, payload) => {
    const service = getSpotifyPresenceServiceOrThrow();
    return service.disconnect(payload?.scope);
  });
  ipcMain.handle("spotify:presence:set-visibility", async (_event, payload) => {
    const service = getSpotifyPresenceServiceOrThrow();
    return service.setVisibility(payload?.scope, {
      showOnProfile: payload?.showOnProfile,
      showAsStatus: payload?.showAsStatus,
    });
  });
  ipcMain.handle("spotify:presence:start", async (_event, payload) => {
    const service = getSpotifyPresenceServiceOrThrow();
    return service.start(payload?.scope);
  });
  ipcMain.handle("spotify:presence:stop", async (_event, payload) => {
    const service = getSpotifyPresenceServiceOrThrow();
    return service.stop(payload?.scope);
  });
  ipcMain.handle("spotify:presence:poll-once", async (_event, payload) => {
    const service = getSpotifyPresenceServiceOrThrow();
    return service.pollOnce(payload?.scope);
  });
  ipcMain.handle("spotify:presence:debug-state", async (_event, payload) => {
    const service = getSpotifyPresenceServiceOrThrow();
    return service.getDebugState(payload?.scope);
  });
  ipcMain.handle("notifications:notify-message", notifyMessageHandler);
  ipcMain.on("notifications:renderer-ready", notificationsRendererReadyHandler);
  ipcMain.on("app:renderer-first-frame-ready", handleRendererFirstFrameReady);
}

function createMainWindow() {
  const existingWindow = getMainWindow();
  if (existingWindow) {
    notificationNavigationCoordinator.registerWindow(existingWindow);
    if (!mainWindowWaitingForFirstFrame && !existingWindow.isVisible()) {
      existingWindow.show();
    }
    return existingWindow;
  }

  loadWindowsBehaviorSettings();
  const startMinimized = shouldStartMinimizedThisLaunch();
  mainWindowWaitingForFirstFrame = !startMinimized;
  mainWindowFirstFrameReady = false;

  if (!startMinimized) {
    showStatusPanel(
      {
        title: "Iniciando Messly",
        subtitle: "",
        detail: "Preparando shell e sessao inicial",
        progressText: "Carregando interface principal",
        progressPercent: 36,
        showProgressBar: true,
        showProgress: true,
      },
      "startup",
    );
  }

  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 980,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    transparent: false,
    backgroundColor: APP_STARTUP_BACKGROUND_COLOR,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#00000000",
      symbolColor: "#f2f2f2",
      height: 38,
    },
    icon: mainWindowIconImageCache || MAIN_WINDOW_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: areDevToolsEnabled,
    },
  });
  mainWindowRef = mainWindow;
  notificationNavigationCoordinator.registerWindow(mainWindow);

  mainWindow.setAutoHideMenuBar(true);
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on("close", (event) => {
    const shouldMinimizeToTray = loadWindowsBehaviorSettings().closeToTray;
    if (!shouldMinimizeToTray || isAppQuitting) {
      return;
    }
    event.preventDefault();
    void createAppTray();
    mainWindow.hide();
  });

  mainWindow.once("ready-to-show", () => {
    if (mainWindow.isDestroyed()) {
      return;
    }
    if (mainWindowFirstFrameReady) {
      revealMainWindowAfterFirstFrame({ startMinimized });
    }
  });
  const mainWindowWebContents = mainWindow.webContents;
  applyWebContentsHardening(mainWindowWebContents);

  const handleMainWindowShortcuts = (event, input) => {
    const inputType = String(input?.type ?? "").toLowerCase();
    if (inputType !== "keydown" && inputType !== "rawkeydown") {
      return;
    }
    if (input?.isAutoRepeat) {
      return;
    }
    const key = String(input?.key ?? "").toLowerCase();
    const ctrlOrMeta = Boolean(input?.control || input?.meta);
    const isDevToolsShortcut = isDevToolsShortcutInput(input);
    const isCtrlR = ctrlOrMeta && !Boolean(input?.shift) && key === "r";
    const isCtrlShiftR = ctrlOrMeta && Boolean(input?.shift) && key === "r";
    const isF5 = key === "f5";
    if (!isDevToolsShortcut && !isCtrlR && !isCtrlShiftR && !isF5) {
      return;
    }
    const webContents = mainWindow.webContents;
    if (!webContents || webContents.isDestroyed()) {
      return;
    }
    if (isDevToolsShortcut) {
      event.preventDefault();
      if (!areDevToolsEnabled) {
        return;
      }
      openEmbeddedDevTools(mainWindow);
      return;
    }
    if (!app.isPackaged) {
      return;
    }
    event.preventDefault();
    if (isCtrlR || isF5) {
      webContents.reload();
      return;
    }
    if (isCtrlShiftR) {
      webContents.reloadIgnoringCache();
      return;
    }
  };

  mainWindow.on("closed", () => {
    if (mainWindowRef === mainWindow) {
      mainWindowRef = null;
    }
    mainWindowWaitingForFirstFrame = false;
    mainWindowFirstFrameReady = false;
    destroyEmbeddedDevToolsHost(mainWindow);
    if (mainWindowWebContents && !mainWindowWebContents.isDestroyed()) {
      mainWindowWebContents.removeListener("before-input-event", handleMainWindowShortcuts);
    }
  });

  mainWindowWebContents.on("before-input-event", handleMainWindowShortcuts);
  mainWindowWebContents.on("devtools-closed", () => {
    destroyEmbeddedDevToolsHost(mainWindow);
  });

  if (!app.isPackaged) {
    let navigationLogCount = 0;
    const logDevNavigation = (label, details = {}) => {
      navigationLogCount += 1;
      console.log(`[electron:nav:${navigationLogCount}] ${label}`, details);
    };

    mainWindowWebContents.on("did-start-loading", () => {
      logDevNavigation("did-start-loading");
    });
    mainWindowWebContents.on("did-stop-loading", () => {
      logDevNavigation("did-stop-loading");
    });
    mainWindowWebContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      logDevNavigation("did-fail-load", { errorCode, errorDescription, validatedURL, isMainFrame });
    });
    mainWindowWebContents.on("did-start-navigation", (_event, url, isInPlace, isMainFrame) => {
      if (!isMainFrame) {
        return;
      }
      logDevNavigation("did-start-navigation", { url, isInPlace });
    });
    mainWindowWebContents.on("did-navigate", (_event, url) => {
      logDevNavigation("did-navigate", { url });
    });
    mainWindow.webContents.on("render-process-gone", (_event, details) => {
      logDevNavigation("render-process-gone", details ?? {});
    });
    mainWindow.on("show", () => {
      logDevNavigation("window-show");
    });
    mainWindow.on("hide", () => {
      logDevNavigation("window-hide");
    });
  }

  mainWindow.on("resize", () => {
    if (!mainWindowWebContents.isDevToolsOpened()) {
      return;
    }
    applyEmbeddedDevToolsLayout(mainWindow);
  });

  mainWindowWebContents.setWindowOpenHandler(() => ({ action: "deny" }));

  mainWindowWebContents.on("did-create-window", (childWindow, details) => {
    applyWebContentsHardening(childWindow.webContents);
    const isCallPopout =
      details.frameName === CALL_POPOUT_FRAME_NAME ||
      details.url === `about:blank${CALL_POPOUT_URL_MARKER}` ||
      details.url.endsWith(CALL_POPOUT_URL_MARKER);

    if (!isCallPopout) {
      return;
    }

    const stripWindowChrome = () => {
      if (childWindow.isDestroyed()) {
        return;
      }
      childWindow.setAutoHideMenuBar(true);
      childWindow.setMenuBarVisibility(false);
      if (typeof childWindow.removeMenu === "function") {
        childWindow.removeMenu();
      }
      if (typeof childWindow.setMenu === "function") {
        childWindow.setMenu(null);
      }
      childWindow.setTitle("");
      childWindow.setBackgroundColor("#090a0c");
      if ((CHILD_WINDOW_ICON_PATH || mainWindowIconImageCache) && typeof childWindow.setIcon === "function") {
        childWindow.setIcon(mainWindowIconImageCache || CHILD_WINDOW_ICON_PATH);
      }
      if (typeof childWindow.setTitleBarOverlay === "function") {
        childWindow.setTitleBarOverlay({
          color: "#00000000",
          symbolColor: "#f2f2f2",
          height: 28,
        });
      }
    };

    const lockWindowTitle = (event) => {
      event.preventDefault();
      if (childWindow.isDestroyed()) {
        return;
      }
      childWindow.setTitle("");
    };

    const preventAltMenu = (event, input) => {
      const key = String(input?.key ?? "").toLowerCase();
      if (key === "alt" || input?.alt) {
        event.preventDefault();
      }
    };

    stripWindowChrome();
    const childWebContents = childWindow.webContents;
    childWindow.on("page-title-updated", lockWindowTitle);
    childWebContents.on("before-input-event", preventAltMenu);
    childWindow.webContents.once("did-finish-load", () => {
      if (childWindow.isDestroyed()) {
        return;
      }
      stripWindowChrome();
      childWindow.setTitle("");
    });
    childWindow.once("ready-to-show", () => {
      if (childWindow.isDestroyed()) {
        return;
      }
      stripWindowChrome();
      childWindow.setTitle("");
      childWindow.show();
    });
    childWindow.once("closed", () => {
      childWindow.removeListener("page-title-updated", lockWindowTitle);
      if (!childWebContents.isDestroyed()) {
        childWebContents.removeListener("before-input-event", preventAltMenu);
      }
    });
  });

  if (!app.isPackaged) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL || DEV_SERVER_URL);
    return mainWindow;
  }

  mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  return mainWindow;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    const callbackUrl = findSpotifyCallbackUrlInCommandLine(commandLine);
    if (callbackUrl) {
      storeSpotifyOAuthCallback(callbackUrl);
    }
    if (!showMainWindow() && app.isReady()) {
      createMainWindow();
    }
  });
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  const callbackUrl = extractSpotifyCallbackUrl(url);
  if (!callbackUrl) {
    return;
  }
  storeSpotifyOAuthCallback(callbackUrl);
  if (!showMainWindow() && app.isReady()) {
    createMainWindow();
  }
});

app.on("web-contents-created", (_event, contents) => {
  applyWebContentsHardening(contents);
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) {
    return;
  }
  if (typeof Menu.setApplicationMenu === "function") {
    Menu.setApplicationMenu(null);
  }
  if (process.platform === "win32" && typeof app.setAppUserModelId === "function") {
    try {
      app.setAppUserModelId(getWindowsNotificationAppId());
    } catch {}
  }
  if (session.defaultSession) {
    installSessionSecurityPolicies(session.defaultSession);
  }
  app.on("session-created", (createdSession) => {
    installSessionSecurityPolicies(createdSession);
  });
  void bootstrapWindowsFirewallRule();
  if (readBooleanEnvFlag(process.env.MESSLY_WINDOWS_NETWORK_DIAGNOSTICS_ON_STARTUP, false)) {
    void collectWindowsNetworkDiagnosticsSnapshot()
      .then((snapshot) => {
        console.info("[firewall] windows network diagnostics snapshot", snapshot);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error ?? "unknown");
        console.warn(`[firewall] failed to collect startup diagnostics: ${message}`);
      });
  }
  registerMesslyProtocolClient();
  loadWindowsBehaviorSettings();
  appUpdater = createConfiguredAppUpdater();
  appUpdater.setBroadcaster(broadcastUpdaterState);
  registerIpcHandlers();
  createMainWindow();
  void createAppTray();
  refreshAppTrayMenu();
  setTimeout(() => {
    removeSecureAuthStorageValue(LEGACY_SESSION_STORAGE_KEY);
    const initialCallbackUrl = findSpotifyCallbackUrlInCommandLine(process.argv);
    if (initialCallbackUrl) {
      storeSpotifyOAuthCallback(initialCallbackUrl);
    }

    const createSpotifyPresenceService = getSpotifyPresenceFactory();
    spotifyPresenceService = createSpotifyPresenceService({
      app,
      shell,
      safeStorage,
      isPackaged: app.isPackaged,
      getWindows: () => BrowserWindow.getAllWindows(),
      waitForOAuthCallback: waitForSpotifyOAuthCallback,
    });

    const autoCheckIntervalMs = Number.parseInt(String(process.env.AUTO_UPDATE_CHECK_INTERVAL_MS ?? ""), 10);
    void runStartupAutoUpdateIfEnabled()
      .catch(() => {})
      .finally(() => {
        setTimeout(() => {
          appUpdater.startAutoCheck(Number.isFinite(autoCheckIntervalMs) ? autoCheckIntervalMs : undefined);
        }, 1500);
      });
  }, 0);

  void prepareIconImages()
    .then(() => {
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed() && mainWindowIconImageCache && typeof mainWindow.setIcon === "function") {
        mainWindow.setIcon(mainWindowIconImageCache);
      }
      if (appTray && trayIconImageCache && !appTray.isDestroyed?.()) {
        appTray.setImage(trayIconImageCache);
      }
    })
    .catch(() => {});

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("before-quit", () => {
  isAppQuitting = true;
  notificationManager?.dispose?.();
  notificationManager = null;
  notificationNavigationCoordinator.dispose();
  if (spotifyPresenceService) {
    spotifyPresenceService.dispose();
    spotifyPresenceService = null;
  }
  destroyEmbeddedDevToolsHost(getMainWindow());
  destroyAppTray();
  hideStatusPanel();
});

app.on("window-all-closed", () => {
  appUpdater?.stopAutoCheck?.();
  if (process.platform !== "darwin" && !loadWindowsBehaviorSettings().closeToTray) {
    app.quit();
  }
});


