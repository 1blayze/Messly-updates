const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { pathToFileURL } = require("node:url");
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

if (process.platform === "win32" && typeof app.setAppUserModelId === "function") {
  try {
    app.setAppUserModelId(getWindowsNotificationAppId());
  } catch {}
}

if (app.commandLine && typeof app.commandLine.appendSwitch === "function") {
  app.commandLine.appendSwitch("enable-gpu-rasterization");
  app.commandLine.appendSwitch("enable-zero-copy");
}

const DEV_SERVER_URL = "http://127.0.0.1:5173";
const CALL_POPOUT_FRAME_NAME = "messly_call_popout";
const CALL_POPOUT_URL_MARKER = "#messly_call_popout";
const PROFILE_MEDIA_CACHE_CONTROL = "public, max-age=31536000, immutable";
const PROFILE_MEDIA_PROXY_PATH = "/media/upload/profile";
const PROFILE_MEDIA_PREFIX_BY_KIND = Object.freeze({
  avatar: "avatars",
  banner: "banners",
});
const ALLOWED_MEDIA_PREFIXES = Object.freeze(["avatars/", "banners/", "attachments/", "messages/", "images/", "videos/"]);
const SAFE_MEDIA_KEY_REGEX = /^[a-z0-9/_\-.]+$/i;
const MIN_SIGNED_URL_TTL_SECONDS = 60;
const MAX_SIGNED_URL_TTL_SECONDS = 300;
const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;
const START_MINIMIZED_ARG = "--start-minimized";
const APP_STARTUP_BACKGROUND_COLOR = "#111314";
const SPOTIFY_OAUTH_CALLBACK_CHANNEL = "spotify:oauth-callback";
const MESSLY_PROTOCOL_SCHEME = "messly";
const SPOTIFY_CALLBACK_HOST = "callback";
const ELECTRON_ASSETS_DIR = path.resolve(__dirname, "assets");
const ELECTRON_ICONS_DIR = path.join(ELECTRON_ASSETS_DIR, "icons");
const APP_ICONS_DIR = path.join(ELECTRON_ICONS_DIR, "app");
const APP_NOTIFICATION_ICON_ICO_PATH = path.join(ELECTRON_ICONS_DIR, "messly.ico");
const APP_NOTIFICATION_ICON_PNG_PATH = path.resolve(
  APP_ICONS_DIR,
  "messly-notification.png",
);
const STATUS_PANEL_MASCOT_PATH = path.join(ELECTRON_ICONS_DIR, "ui", "messly.svg");
const WINDOWS_BEHAVIOR_SETTINGS_FILE = "windows-behavior-settings.json";
const HIDDEN_DIRECT_MESSAGES_STATE_FILE = "hidden-direct-messages-state.json";
const SECURE_AUTH_STORAGE_FILE = "secure-auth-storage.json";
const SECURE_AUTH_STORAGE_KEY_REGEX = /^[a-z0-9:_./-]{1,200}$/i;
const LEGACY_REFRESH_TOKEN_STORAGE_KEY = "messly.auth.refresh-token";
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
const PROJECT_SCOPED_REFRESH_TOKEN_STORAGE_KEY = (() => {
  const supabaseUrlRaw = String(process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "").trim();
  if (!supabaseUrlRaw) {
    return LEGACY_REFRESH_TOKEN_STORAGE_KEY;
  }

  try {
    const parsed = new URL(supabaseUrlRaw);
    const projectRef = String(parsed.hostname.split(".")[0] ?? "").trim();
    if (projectRef) {
      return `messly.auth.refresh-token.${projectRef}`;
    }
  } catch {
    // Fallback below.
  }

  return LEGACY_REFRESH_TOKEN_STORAGE_KEY;
})();
const TURNSTILE_CSP_SOURCE = "https://challenges.cloudflare.com";
const CLOUDFLARE_INSIGHTS_SCRIPT_SOURCE = "https://static.cloudflareinsights.com";
const STATUS_PANEL_ENABLED = (() => {
  const rawValue = String(process.env.MESSLY_ENABLE_STARTUP_STATUS_PANEL ?? "").trim().toLowerCase();
  if (rawValue) {
    return !["0", "false", "off", "no"].includes(rawValue);
  }
  // Enabled by default in packaged builds to guarantee pre-launch update visibility.
  return app.isPackaged;
})();
const STATUS_PANEL_PROGRESS_BYTES_VISIBILITY_THRESHOLD = 0;
const STATUS_PANEL_PHASE = Object.freeze({
  IDLE: "idle",
  CHECKING: "checking",
  UPDATE_AVAILABLE: "update-available",
  DOWNLOADING: "downloading",
  APPLYING: "applying",
  INSTALLING: "installing",
  RELAUNCHING: "relaunching",
  LAUNCHING: "launching",
  LOADING_SHELL: "loading-shell",
  READY: "ready",
  FAILED: "failed",
  RETRYING: "retrying",
});
const STATUS_PANEL_COPY_PT_BR = Object.freeze({
  [STATUS_PANEL_PHASE.CHECKING]: Object.freeze({
    title: "Verificando atualizações...",
    subtitle: "Preparando aplicativo",
    showProgressBar: true,
    showProgress: false,
    indeterminate: true,
    progressPercent: 22,
  }),
  [STATUS_PANEL_PHASE.UPDATE_AVAILABLE]: Object.freeze({
    title: "Nova atualização encontrada",
    subtitle: "Preparando download",
    showProgressBar: true,
    showProgress: false,
    indeterminate: true,
    progressPercent: 28,
  }),
  [STATUS_PANEL_PHASE.DOWNLOADING]: Object.freeze({
    title: "Baixando atualização",
    subtitle: "Baixando pacote de atualização",
    showProgressBar: true,
    showProgress: true,
    indeterminate: false,
    progressPercent: 4,
  }),
  [STATUS_PANEL_PHASE.APPLYING]: Object.freeze({
    title: "Preparando atualização",
    subtitle: "Organizando arquivos para instalação",
    showProgressBar: true,
    showProgress: false,
    indeterminate: true,
    progressPercent: 94,
  }),
  [STATUS_PANEL_PHASE.INSTALLING]: Object.freeze({
    title: "Instalando atualização",
    subtitle: "Não feche o aplicativo",
    showProgressBar: true,
    showProgress: false,
    indeterminate: true,
    progressPercent: 96,
  }),
  [STATUS_PANEL_PHASE.RELAUNCHING]: Object.freeze({
    title: "Atualização concluída",
    subtitle: "Reiniciando aplicativo",
    showProgressBar: true,
    showProgress: false,
    indeterminate: true,
    progressPercent: 97,
  }),
  [STATUS_PANEL_PHASE.LAUNCHING]: Object.freeze({
    title: "Iniciando Messly",
    subtitle: "Preparando aplicativo",
    showProgressBar: true,
    showProgress: false,
    indeterminate: true,
    progressPercent: 18,
  }),
  [STATUS_PANEL_PHASE.LOADING_SHELL]: Object.freeze({
    title: "Carregando Messly",
    subtitle: "Carregando interface",
    showProgressBar: true,
    showProgress: false,
    indeterminate: true,
    progressPercent: 68,
  }),
  [STATUS_PANEL_PHASE.READY]: Object.freeze({
    title: "Abrindo Messly",
    subtitle: "Inicializando interface",
    showProgressBar: true,
    showProgress: false,
    indeterminate: true,
    progressPercent: 100,
  }),
  [STATUS_PANEL_PHASE.FAILED]: Object.freeze({
    title: "Falha ao atualizar",
    subtitle: "Tentando novamente",
    showProgressBar: true,
    showProgress: false,
    indeterminate: false,
    progressPercent: 0,
  }),
  [STATUS_PANEL_PHASE.RETRYING]: Object.freeze({
    title: "Tentando novamente",
    subtitle: "Preparando aplicativo",
    showProgressBar: true,
    showProgress: false,
    indeterminate: true,
    progressPercent: 34,
  }),
});
const STATUS_PANEL_MIN_VISIBLE_MS = Object.freeze({
  [STATUS_PANEL_PHASE.CHECKING]: 460,
  [STATUS_PANEL_PHASE.UPDATE_AVAILABLE]: 640,
  [STATUS_PANEL_PHASE.DOWNLOADING]: 0,
  [STATUS_PANEL_PHASE.APPLYING]: 720,
  [STATUS_PANEL_PHASE.INSTALLING]: 760,
  [STATUS_PANEL_PHASE.RELAUNCHING]: 640,
  [STATUS_PANEL_PHASE.LAUNCHING]: 360,
  [STATUS_PANEL_PHASE.LOADING_SHELL]: 320,
  [STATUS_PANEL_PHASE.READY]: 220,
  [STATUS_PANEL_PHASE.FAILED]: 880,
  [STATUS_PANEL_PHASE.RETRYING]: 520,
});
const MAIN_WINDOW_FIRST_FRAME_TIMEOUT_MS = 12_000;
const STARTUP_AUTO_UPDATE_BLOCK_TIMEOUT_MS = readBoundedIntegerEnv(
  process.env.AUTO_UPDATE_BLOCK_TIMEOUT_MS,
  app.isPackaged ? 12_000 : 8_000,
  5_000,
  180_000,
);
const BLOCK_MAIN_WINDOW_ON_STARTUP_UPDATE = readBooleanEnvFlag(process.env.AUTO_UPDATE_BLOCK_STARTUP, app.isPackaged);
const STARTUP_STATUS_PANEL_HARD_TIMEOUT_MS = readBoundedIntegerEnv(
  process.env.AUTO_UPDATE_STATUS_PANEL_TIMEOUT_MS,
  app.isPackaged ? 24_000 : 16_000,
  12_000,
  180_000,
);
const STARTUP_AUTO_UPDATE_CHECK_RETRY_MAX = readBoundedIntegerEnv(
  process.env.AUTO_UPDATE_STARTUP_CHECK_RETRIES,
  3,
  1,
  6,
);
const STARTUP_AUTO_UPDATE_DOWNLOAD_RETRY_MAX = readBoundedIntegerEnv(
  process.env.AUTO_UPDATE_STARTUP_DOWNLOAD_RETRIES,
  3,
  1,
  6,
);
const STARTUP_AUTO_UPDATE_RETRY_BASE_DELAY_MS = readBoundedIntegerEnv(
  process.env.AUTO_UPDATE_STARTUP_RETRY_BASE_DELAY_MS,
  1_600,
  250,
  20_000,
);
const STARTUP_AUTO_UPDATE_RETRY_MAX_DELAY_MS = readBoundedIntegerEnv(
  process.env.AUTO_UPDATE_STARTUP_RETRY_MAX_DELAY_MS,
  10_000,
  800,
  60_000,
);
const STARTUP_AUTO_UPDATE_CHECK_STEP_TIMEOUT_MS = readBoundedIntegerEnv(
  process.env.AUTO_UPDATE_STARTUP_CHECK_STEP_TIMEOUT_MS,
  app.isPackaged ? 10_000 : 4_500,
  3_000,
  120_000,
);
const STARTUP_AUTO_UPDATE_DOWNLOAD_STEP_TIMEOUT_MS = readBoundedIntegerEnv(
  process.env.AUTO_UPDATE_STARTUP_DOWNLOAD_STEP_TIMEOUT_MS,
  app.isPackaged ? 18_000 : 7_500,
  3_500,
  240_000,
);
const RENDERER_BOOTSTRAP_MAX_RETRIES = 3;
const RENDERER_BOOTSTRAP_RETRY_DELAYS_MS = Object.freeze([700, 1400, 2600]);
const RENDERER_BOOTSTRAP_ABORT_CODE = -3;
const RENDERER_BOOTSTRAP_RETRIABLE_ERROR_CODES = new Set([
  -105, // ERR_NAME_NOT_RESOLVED
  -106, // ERR_INTERNET_DISCONNECTED
  -102, // ERR_CONNECTION_REFUSED
  -118, // ERR_CONNECTION_TIMED_OUT
  -137, // ERR_NAME_RESOLUTION_FAILED
]);
const STATUS_PANEL_FALLBACK_TITLE = "Preparando Messly";
const STATUS_PANEL_FALLBACK_SUBTITLE = "Aguarde um instante";
const PRODUCTION_SCRIPT_SOURCE = areDevToolsEnabled
  ? `script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' ${TURNSTILE_CSP_SOURCE} ${CLOUDFLARE_INSIGHTS_SCRIPT_SOURCE}`
  : `script-src 'self' 'wasm-unsafe-eval' ${TURNSTILE_CSP_SOURCE} ${CLOUDFLARE_INSIGHTS_SCRIPT_SOURCE}`;
// Applied to packaged builds to lock down renderer document capabilities.
const PRODUCTION_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  PRODUCTION_SCRIPT_SOURCE,
  `script-src-elem 'self' ${TURNSTILE_CSP_SOURCE} ${CLOUDFLARE_INSIGHTS_SCRIPT_SOURCE}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  `frame-src 'self' ${TURNSTILE_CSP_SOURCE}`,
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");
const ALLOWED_APP_PERMISSIONS = Object.freeze(["media", "display-capture"]);
const WINDOWS_FIREWALL_RULE_NAME = String(process.env.MESSLY_FIREWALL_RULE_NAME ?? DEFAULT_FIREWALL_RULE_NAME).trim() || DEFAULT_FIREWALL_RULE_NAME;
const WINDOWS_FIREWALL_PROFILE = String(process.env.MESSLY_FIREWALL_PROFILE ?? DEFAULT_FIREWALL_PROFILE).trim().toLowerCase() || DEFAULT_FIREWALL_PROFILE;
const DEFAULT_PUBLIC_WEB_ORIGIN = "https://messly.site";
const DEFAULT_PUBLIC_API_BASE_URL = "https://gateway.messly.site";
const DEFAULT_PUBLIC_GATEWAY_URL = "wss://gateway.messly.site/gateway";
const REQUIRED_PRODUCTION_RENDERER_URL = "https://messly.site/";
const BUNDLED_RENDERER_INDEX_RELATIVE_PATH = path.join("dist", "index.html");
const STARTUP_DIAGNOSTICS_FILE = "startup-diagnostics.log";
const STARTUP_DIAGNOSTICS_MAX_BYTES = 2 * 1024 * 1024;

function resolveAppIconPath(fileName) {
  const iconPath = path.join(APP_ICONS_DIR, fileName);
  return fs.existsSync(iconPath) ? iconPath : undefined;
}

function resolvePackagedElectronIconPath(fileName) {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, "app.asar", "electron", "assets", "icons", fileName) : "",
    process.resourcesPath ? path.join(process.resourcesPath, "electron", "assets", "icons", fileName) : "",
    process.resourcesPath ? path.join(process.resourcesPath, "assets", "icons", fileName) : "",
  ]
    .map((candidate) => String(candidate ?? "").trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return "";
}

function resolveWindowsIcoPath() {
  const packagedIcoPath = resolvePackagedElectronIconPath("messly.ico");
  const candidates = [
    APP_NOTIFICATION_ICON_ICO_PATH,
    packagedIcoPath,
  ]
    .map((candidate) => String(candidate ?? "").trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

const APP_WINDOW_ICON_PNG_PATH =
  resolveAppIconPath("messly-notification@128.png") ??
  resolveAppIconPath("messly-notification.png");
const APP_WINDOW_ICON_SVG_PATH = resolveAppIconPath("messly-icon.svg");
const APP_TRAY_ICON_SVG_PATH = resolveAppIconPath("messly-tray.svg");
const APP_WINDOW_ICON_ICO_PATH = resolveWindowsIcoPath();

const MAIN_WINDOW_ICON_PATH = process.platform === "win32"
  ? APP_WINDOW_ICON_ICO_PATH ?? APP_WINDOW_ICON_PNG_PATH ?? APP_WINDOW_ICON_SVG_PATH ?? process.execPath
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
let statusPanelAutoHideTimer = null;
let statusPanelPhase = STATUS_PANEL_PHASE.IDLE;
let statusPanelPhaseSinceMs = 0;
let statusPanelPhaseTransitionTimer = null;
let statusPanelQueuedPhaseTransition = null;
let statusPanelDisplayProgressPercent = 0;
let statusPanelProgressInterpolationMode = "";
let mainWindowWaitingForFirstFrame = false;
let mainWindowFirstFrameReady = false;
let mainWindowFirstFrameFallbackTimer = null;
let pendingSpotifyOAuthCallback = null;
const spotifyOAuthCallbackWaiters = new Set();
let spotifyPresenceService = null;
let embeddedDevToolsHostViewRef = null;
let notificationIconImageCache = undefined;
let startupAutoUpdatePromise = null;
let updaterAutoInstallInFlight = false;
let updaterInstallGuardActive = false;
let windowsHiddenForUpdateFlow = false;
let windowsFirewallBootstrapPromise = null;
let updaterBroadcastThrottleTimer = null;
let updaterBroadcastQueuedState = null;
let updaterBroadcastLastAtMs = 0;
let startupUpdaterBlockTimedOut = false;
let startupAutoUpdateGateExpired = false;
let startupStatusPanelLifecycleActive = false;
let startupStatusPanelHardStopTimer = null;
let startupDiagnosticsLogPathCache = null;
const ephemeralSecureAuthStorage = new Map();
const hardenedWebContents = new WeakSet();
const hardenedSessions = new WeakSet();
const startupPerfMarks = new Map();

function normalizeStartupDiagnosticDetails(rawDetails) {
  const sourceDetails =
    rawDetails && typeof rawDetails === "object" && !Array.isArray(rawDetails)
      ? rawDetails
      : { value: rawDetails ?? null };
  const seen = new WeakSet();
  try {
    const encoded = JSON.stringify(sourceDetails, (_key, value) => {
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }
      if (typeof value === "bigint") {
        return value.toString();
      }
      if (typeof value === "function") {
        return `[function:${value.name || "anonymous"}]`;
      }
      if (value && typeof value === "object") {
        if (seen.has(value)) {
          return "[circular]";
        }
        seen.add(value);
      }
      return value;
    });
    if (!encoded) {
      return {};
    }
    const parsed = JSON.parse(encoded);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return { serializationFailed: true };
  }
}

function resolveStartupDiagnosticsLogPath() {
  if (startupDiagnosticsLogPathCache) {
    return startupDiagnosticsLogPathCache;
  }

  try {
    const userDataPath = app.getPath("userData");
    if (!userDataPath) {
      return null;
    }
    startupDiagnosticsLogPathCache = path.join(userDataPath, STARTUP_DIAGNOSTICS_FILE);
    return startupDiagnosticsLogPathCache;
  } catch {
    return null;
  }
}

function appendStartupDiagnosticLogEntry(entry) {
  const logPath = resolveStartupDiagnosticsLogPath();
  if (!logPath) {
    return;
  }

  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (fs.existsSync(logPath)) {
      const stats = fs.statSync(logPath);
      if (Number(stats?.size ?? 0) >= STARTUP_DIAGNOSTICS_MAX_BYTES) {
        const backupPath = `${logPath}.previous`;
        try {
          if (fs.existsSync(backupPath)) {
            fs.unlinkSync(backupPath);
          }
        } catch {}
        try {
          fs.renameSync(logPath, backupPath);
        } catch {}
      }
    }
    fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {}
}

function isBrokenPipeStartupError(error) {
  const code = String(error?.code ?? "").toUpperCase();
  if (code === "EPIPE") {
    return true;
  }
  const message = String(error?.message ?? "");
  return /broken pipe/i.test(message);
}

function safeStartupConsoleWrite(level, line, details) {
  const targetLevel = String(level ?? "").trim().toLowerCase();
  const targetMethod =
    targetLevel === "debug" || targetLevel === "warn" || targetLevel === "error" || targetLevel === "info"
      ? targetLevel
      : "info";

  try {
    if (typeof console?.[targetMethod] === "function") {
      console[targetMethod](line, details);
      return;
    }
    console.info(line, details);
  } catch (error) {
    if (isBrokenPipeStartupError(error)) {
      return;
    }
    try {
      appendStartupDiagnosticLogEntry({
        at: new Date().toISOString(),
        pid: process.pid,
        level: "warn",
        event: "startup-console-write-failed",
        details: {
          requestedLevel: targetMethod,
          error: String(error?.message ?? error),
        },
      });
    } catch {}
  }
}

function installConsoleBrokenPipeGuard() {
  const guardedMethods = ["log", "debug", "info", "warn", "error"];
  for (const methodName of guardedMethods) {
    const originalMethod = console?.[methodName];
    if (typeof originalMethod !== "function") {
      continue;
    }
    console[methodName] = (...args) => {
      try {
        return originalMethod.apply(console, args);
      } catch (error) {
        if (isBrokenPipeStartupError(error)) {
          return undefined;
        }
        throw error;
      }
    };
  }
}

installConsoleBrokenPipeGuard();

function logStartupDiagnostic(event, details = {}, level = "info") {
  const normalizedEvent = String(event ?? "").trim() || "unknown";
  const normalizedLevel = ["debug", "info", "warn", "error"].includes(String(level ?? "").trim().toLowerCase())
    ? String(level).trim().toLowerCase()
    : "info";
  const safeDetails = normalizeStartupDiagnosticDetails(details);
  const line = `[startup:${normalizedEvent}]`;

  safeStartupConsoleWrite(normalizedLevel, line, safeDetails);

  appendStartupDiagnosticLogEntry({
    at: new Date().toISOString(),
    pid: process.pid,
    level: normalizedLevel,
    event: normalizedEvent,
    details: safeDetails,
  });
}

function markMainStartupPerf(markName, details = {}) {
  const normalizedMark = String(markName ?? "").trim();
  if (!normalizedMark) {
    return;
  }

  const atMs = Number(performance.now().toFixed(2));
  startupPerfMarks.set(normalizedMark, {
    name: normalizedMark,
    atMs,
    details: details && typeof details === "object" ? { ...details } : {},
  });
  logStartupDiagnostic(`mark:${normalizedMark}`, {
    atMs,
    ...details,
  }, "debug");

  if (isDevEnvironment) {
    console.debug(`[electron:startup] mark:${normalizedMark}`, {
      atMs,
      ...details,
    });
  }
}

function measureMainStartupPerf(label, startMark, endMark, details = {}) {
  const normalizedLabel = String(label ?? "").trim();
  const start = startupPerfMarks.get(String(startMark ?? "").trim());
  const end = startupPerfMarks.get(String(endMark ?? "").trim());
  if (!normalizedLabel || !start || !end) {
    return null;
  }

  const durationMs = Number(Math.max(0, end.atMs - start.atMs).toFixed(2));
  logStartupDiagnostic(`measure:${normalizedLabel}`, {
    durationMs,
    startMark: start.name,
    endMark: end.name,
    ...details,
  }, "debug");
  if (isDevEnvironment) {
    console.debug(`[electron:startup] measure:${normalizedLabel}`, {
      durationMs,
      startMark: start.name,
      endMark: end.name,
      ...details,
    });
  }
  return durationMs;
}

function getMainStartupPerfSnapshot() {
  const marks = Array.from(startupPerfMarks.values())
    .sort((left, right) => Number(left.atMs ?? 0) - Number(right.atMs ?? 0))
    .slice(-24)
    .map((entry) => ({
      name: entry.name,
      atMs: entry.atMs,
      details: entry.details && typeof entry.details === "object" ? { ...entry.details } : {},
    }));

  const readyAt = startupPerfMarks.get("main:when-ready");
  const firstFrameAt = startupPerfMarks.get("main:renderer-first-frame");
  const revealAt = startupPerfMarks.get("main:window-revealed");
  const processEntryAt = startupPerfMarks.get("main:entry");
  const createWindowAt = startupPerfMarks.get("main:create-window:new");
  const mainWindowReadyAt = startupPerfMarks.get("main:window-ready-to-show");

  return {
    marks,
    metrics: {
      processEntryToWhenReadyMs:
        processEntryAt && readyAt ? Number(Math.max(0, readyAt.atMs - processEntryAt.atMs).toFixed(2)) : null,
      processEntryToCreateWindowMs:
        processEntryAt && createWindowAt ? Number(Math.max(0, createWindowAt.atMs - processEntryAt.atMs).toFixed(2)) : null,
      processEntryToWindowReadyToShowMs:
        processEntryAt && mainWindowReadyAt
          ? Number(Math.max(0, mainWindowReadyAt.atMs - processEntryAt.atMs).toFixed(2))
          : null,
      processEntryToFirstFrameMs:
        processEntryAt && firstFrameAt ? Number(Math.max(0, firstFrameAt.atMs - processEntryAt.atMs).toFixed(2)) : null,
      processEntryToWindowRevealMs:
        processEntryAt && revealAt ? Number(Math.max(0, revealAt.atMs - processEntryAt.atMs).toFixed(2)) : null,
    },
  };
}

markMainStartupPerf("main:entry");
logStartupDiagnostic("main:entry", {
  appIsPackaged: app.isPackaged,
  argv: process.argv,
  startupDiagnosticsPath: resolveStartupDiagnosticsLogPath(),
});

function logNotificationDebug(event, details = {}) {
  if (!isDevEnvironment) {
    return;
  }
  console.debug(`[electron:notifications] ${event}`, details);
}

function getWindowsNotificationAppId() {
  const packagedDefault = String(WINDOWS_APP_USER_MODEL_ID ?? APP_ID ?? APP_NAME).trim();
  if (app.isPackaged && packagedDefault) {
    return packagedDefault;
  }

  const configured = String(process.env.MESSLY_WINDOWS_AUMID ?? packagedDefault).trim();
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

function formatTransferRate(bytesPerSecond) {
  const speed = Number(bytesPerSecond);
  if (!Number.isFinite(speed) || speed <= 0) {
    return "";
  }
  return `${formatTransferBytes(speed)}/s`;
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

function getProductionRendererOrigin() {
  return normalizeOriginValue(REQUIRED_PRODUCTION_RENDERER_URL);
}

function getExpectedProductionRendererUrl() {
  return REQUIRED_PRODUCTION_RENDERER_URL;
}

function resolveBundledRendererFilePathCandidates() {
  return [
    path.resolve(__dirname, "..", BUNDLED_RENDERER_INDEX_RELATIVE_PATH),
    process.resourcesPath ? path.join(process.resourcesPath, "app.asar", BUNDLED_RENDERER_INDEX_RELATIVE_PATH) : "",
    process.resourcesPath ? path.join(process.resourcesPath, BUNDLED_RENDERER_INDEX_RELATIVE_PATH) : "",
  ]
    .map((candidate) => String(candidate ?? "").trim())
    .filter(Boolean);
}

function resolveBundledRendererStartupUrl() {
  const candidates = resolveBundledRendererFilePathCandidates();
  for (const candidatePath of candidates) {
    try {
      if (!fs.existsSync(candidatePath)) {
        continue;
      }
      return pathToFileURL(candidatePath).toString();
    } catch {}
  }
  return null;
}

function isLocalRendererHostname(hostname) {
  const normalizedHostname = String(hostname ?? "").trim().toLowerCase();
  return normalizedHostname === "localhost" || normalizedHostname === "127.0.0.1" || normalizedHostname === "::1";
}

function logInvalidProductionRendererUrl(received, expected, reason, blockedOrigin = "") {
  console.error("[electron] invalid production renderer url");
  console.error(`[electron] received: ${received}`);
  console.error(`[electron] expected: ${expected}`);
  if (reason) {
    console.error(`[electron] reason: ${reason}`);
  }
  if (blockedOrigin) {
    console.error(`[electron] blocked production renderer origin: ${blockedOrigin}`);
  }
}

function validateProductionRendererUrlOrThrow(candidateUrl) {
  const expectedUrl = getExpectedProductionRendererUrl();
  let parsedCandidate;
  try {
    parsedCandidate = new URL(candidateUrl);
  } catch {
    logInvalidProductionRendererUrl(
      String(candidateUrl ?? "").trim() || "(empty)",
      expectedUrl,
      "malformed production renderer URL",
    );
    throw new Error("Invalid production renderer URL configuration.");
  }

  const candidateProtocol = parsedCandidate.protocol.toLowerCase();
  const candidateHostname = parsedCandidate.hostname.toLowerCase();
  const candidatePathname = parsedCandidate.pathname || "/";
  const normalizedCandidateUrl = parsedCandidate.toString();
  const blockedByProtocol = candidateProtocol === "file:" || candidateProtocol === "app:" || candidateProtocol === "data:";
  const blockedByLoopbackHost = isLocalRendererHostname(candidateHostname);
  const isExpectedProductionUrl =
    candidateProtocol === "https:"
    && candidateHostname === "messly.site"
    && (candidatePathname === "/" || candidatePathname === "")
    && !parsedCandidate.search
    && !parsedCandidate.hash
    && !parsedCandidate.port;

  if (!isExpectedProductionUrl) {
    const blockedOrigin = blockedByProtocol
      ? candidateProtocol
      : blockedByLoopbackHost
        ? parsedCandidate.origin
        : "";
    const reason = blockedByProtocol
      ? `unsupported production renderer protocol: ${candidateProtocol}`
      : blockedByLoopbackHost
        ? `loopback production renderer host is forbidden: ${candidateHostname}`
        : "production renderer URL must be exactly https://messly.site";
    logInvalidProductionRendererUrl(normalizedCandidateUrl, expectedUrl, reason, blockedOrigin);
    throw new Error("Invalid production renderer URL configuration.");
  }

  return expectedUrl;
}

function resolveRendererStartupUrl() {
  const mode = app.isPackaged ? "production" : "development";
  console.info(`[electron] desktop renderer mode: ${mode}`);
  logStartupDiagnostic("renderer:mode-selected", {
    mode,
    packaged: app.isPackaged,
  });

  if (!app.isPackaged) {
    const devRendererUrl = String(
      process.env.ELECTRON_RENDERER_URL
      ?? process.env.VITE_DEV_SERVER_URL
      ?? DEV_SERVER_URL,
    ).trim() || DEV_SERVER_URL;
    console.info(`[electron] desktop renderer url selected: ${devRendererUrl}`);
    logStartupDiagnostic("renderer:url-selected", {
      mode,
      source: "dev-server",
      rendererUrl: devRendererUrl,
    });
    return devRendererUrl;
  }

  const explicitProductionCandidate = String(
    process.env.ELECTRON_RENDERER_URL
    ?? process.env.MESSLY_SITE_URL
    ?? process.env.WEB_URL
    ?? process.env.APP_URL
    ?? "",
  ).trim();
  const productionCandidate = explicitProductionCandidate || getExpectedProductionRendererUrl();
  const rendererUrl = validateProductionRendererUrlOrThrow(productionCandidate);
  console.info(`[electron] desktop renderer url selected: ${rendererUrl}`);
  logStartupDiagnostic("renderer:url-selected", {
    mode,
    source: explicitProductionCandidate ? "env-explicit" : "default-remote",
    rendererUrl,
  });
  return rendererUrl;
}

function getSecureAllowedNavigationOrigins() {
  const origins = new Set();
  for (const originValue of EXTRA_ALLOWED_HTTPS_ORIGINS) {
    const origin = normalizeOriginValue(originValue);
    if (origin) {
      origins.add(origin);
    }
  }
  const productionOrigin = getProductionRendererOrigin();
  if (productionOrigin) {
    origins.add(productionOrigin);
  }
  if (!app.isPackaged) {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL || DEV_SERVER_URL;
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
  if (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") {
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
  if (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") {
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

  const productionOrigin = getProductionRendererOrigin();
  if (productionOrigin && parsedUrl.origin === productionOrigin) {
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
    targetSession.webRequest.onBeforeRequest((details, callback) => {
      const currentUrl = String(details?.url ?? "");
      const redirectURL = rewriteLegacyPublicApiRequestUrl(currentUrl);
      if (redirectURL && redirectURL !== currentUrl) {
        callback({ redirectURL });
        return;
      }

      callback({});
    });

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

function buildStatusPanelHtmlV2(payload) {
  const rawTitle = String(payload?.title ?? "").trim();
  const rawSubtitle = String(payload?.subtitle ?? "").trim();
  const rawProgressText = String(payload?.progressText ?? "").trim();
  const rawDetail = String(payload?.detail ?? "").trim();
  const hasRenderableCopy = Boolean(rawTitle || rawSubtitle || rawProgressText || rawDetail);
  const shouldUseFallbackCopy = !rawTitle && !rawSubtitle && !rawProgressText && !rawDetail;
  const title = escapeHtml(rawTitle || (shouldUseFallbackCopy ? STATUS_PANEL_FALLBACK_TITLE : ""));
  const subtitle = escapeHtml(rawSubtitle || (shouldUseFallbackCopy ? STATUS_PANEL_FALLBACK_SUBTITLE : ""));
  const progressText = escapeHtml(rawProgressText);
  const detail = escapeHtml(rawDetail);
  const showTitle = Boolean(title);
  const showSubtitle = Boolean(subtitle);
  const showProgress = Boolean(payload?.showProgress || progressText);
  const showProgressBar = payload?.showProgressBar !== false || !hasRenderableCopy;
  const showDetail = Boolean(detail);
  const progressValue = Math.max(0, Math.min(100, Number(payload?.progressPercent ?? 0)));
  const indeterminate = Boolean(payload?.indeterminate);
  const progressFillWidth = indeterminate ? 38 : progressValue;
  const mascotSrc = getStatusPanelMascotDataUrl();

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Messly Status</title>
  <style>
    :root {
      color-scheme: dark;
      --card: #242b37;
      --text: #f4f7fb;
      --muted: #acb6c7;
      --track: rgba(255,255,255,.16);
      --fill: linear-gradient(90deg, #ffffff 0%, #ffffff 100%);
    }
    * {
      box-sizing: border-box;
    }
    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: var(--card);
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto;
      user-select: none;
      -webkit-font-smoothing: antialiased;
    }
    .stage {
      position: fixed;
      inset: 0;
      width: 100%;
      height: 100%;
      display: grid;
      place-items: center;
      padding: 0;
      background: var(--card);
    }
    .card {
      width: 100%;
      min-height: 100%;
      background: var(--card);
      border: 0;
      border-radius: 0;
      box-shadow: none;
      padding: 40px 24px 38px;
      -webkit-app-region: drag;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 28px;
      opacity: 1;
      transform: translateY(0);
      animation: fade-in 280ms cubic-bezier(.22,.9,.32,1);
    }
    .brand {
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 18px;
      text-align: center;
      padding-top: 0;
      opacity: 0;
      transform: translateY(4px);
      animation: fade-up 320ms cubic-bezier(.22,.9,.32,1) 80ms forwards;
    }
    .avatar {
      width: 96px;
      height: 96px;
      object-fit: contain;
      display: block;
      background: transparent;
      image-rendering: -webkit-optimize-contrast;
      filter: drop-shadow(0 12px 20px rgba(0,0,0,.34));
      animation: logo-breathe 3.2s ease-in-out infinite;
    }
    .copy {
      display: grid;
      gap: 10px;
      justify-items: center;
      min-height: 62px;
      align-content: start;
    }
    .title {
      margin: 0;
      color: var(--text);
      font-size: 29px;
      line-height: 1.08;
      font-weight: 700;
      letter-spacing: -.018em;
      text-wrap: balance;
    }
    .subtitle {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.35;
      min-height: 18px;
      text-wrap: balance;
    }
    .footer {
      width: 100%;
      display: grid;
      gap: 14px;
      justify-items: center;
      margin-top: 0;
      opacity: 0;
      transform: translateY(6px);
      animation: fade-up 320ms cubic-bezier(.22,.9,.32,1) 150ms forwards;
    }
    .progress-track {
      width: min(220px, 64vw);
      height: 6px;
      border-radius: 999px;
      background: var(--track);
      overflow: hidden;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.06);
    }
    .progress-fill {
      width: ${progressFillWidth}%;
      height: 100%;
      border-radius: 999px;
      background: var(--fill);
      transition: width 360ms cubic-bezier(.22,.9,.32,1);
      box-shadow: 0 0 10px rgba(255,255,255,.32);
      transform-origin: 0 50%;
      ${indeterminate ? "animation: indeterminate 1300ms ease-in-out infinite;" : ""}
    }
    .progress-text {
      margin: 0;
      color: rgba(234, 240, 252, .92);
      font-size: 11px;
      line-height: 1.25;
      font-weight: 500;
      text-align: center;
      letter-spacing: .012em;
    }
    .detail {
      margin: 0;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.35;
      text-align: center;
      max-width: 92%;
    }
    @keyframes indeterminate {
      0% { transform: translateX(-70%); opacity: .86; }
      50% { transform: translateX(46%); opacity: 1; }
      100% { transform: translateX(170%); opacity: .86; }
    }
    @keyframes fade-in {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes fade-up {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes logo-breathe {
      0% { transform: scale(1); }
      50% { transform: scale(1.035); }
      100% { transform: scale(1); }
    }
  </style>
</head>
<body>
  <main class="stage">
    <section class="card">
      <div class="brand">
        ${
          mascotSrc
            ? `<img class="avatar" src="${mascotSrc}" alt="">`
            : `<div style="width:96px;height:96px;"></div>`
        }
        ${showTitle || showSubtitle ? `<div class="copy">${showTitle ? `<p class="title">${title}</p>` : ""}${showSubtitle ? `<p class="subtitle">${subtitle}</p>` : ""}</div>` : ""}
      </div>
      <div class="footer">
        ${showProgressBar ? `<div class="progress-track"><div class="progress-fill"></div></div>` : ""}
        ${showProgress ? `<p class="progress-text">${progressText || `${Math.round(progressValue)}%`}</p>` : ""}
        ${showDetail ? `<p class="detail">${detail}</p>` : ""}
      </div>
    </section>
  </main>
</body>
</html>`;
}

function buildRendererLoadFailureHtml(payload = {}) {
  const rendererUrl = String(payload.rendererUrl ?? getExpectedProductionRendererUrl()).trim() || getExpectedProductionRendererUrl();
  const reason = escapeHtml(String(payload.reason ?? "Falha ao carregar a interface."));
  const details = escapeHtml(String(payload.details ?? "").trim());
  const errorCode = Number.isFinite(Number(payload.errorCode)) ? Number(payload.errorCode) : null;
  const errorDescription = escapeHtml(String(payload.errorDescription ?? "").trim());
  const safeRendererUrl = escapeHtml(rendererUrl);
  const safeRendererUrlJs = JSON.stringify(rendererUrl);
  const safeErrorCode = errorCode !== null ? String(errorCode) : "";

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Messly</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0d1117;
      --card: #1b2432;
      --text: #f2f5fa;
      --muted: #a7b3c7;
      --accent: #d8e7ff;
      --accent2: #8bb1ff;
      --danger: #ff9aa2;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      background: radial-gradient(1200px 700px at 15% -5%, #253247 0%, var(--bg) 55%), var(--bg);
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto;
      color: var(--text);
    }
    main {
      width: 100%;
      height: 100%;
      display: grid;
      place-items: center;
      padding: 28px;
    }
    .card {
      width: min(640px, 92vw);
      border-radius: 16px;
      background: linear-gradient(180deg, rgba(33,44,61,.92) 0%, rgba(24,31,44,.92) 100%);
      border: 1px solid rgba(255,255,255,.08);
      box-shadow: 0 22px 48px rgba(0,0,0,.45);
      padding: 28px 24px;
      display: grid;
      gap: 16px;
    }
    h1 {
      margin: 0;
      font-size: 28px;
      line-height: 1.15;
      letter-spacing: -.02em;
    }
    p {
      margin: 0;
      color: var(--muted);
      line-height: 1.5;
      font-size: 14px;
    }
    .warn { color: var(--danger); font-size: 13px; }
    .meta {
      background: rgba(0,0,0,.26);
      border: 1px solid rgba(255,255,255,.08);
      border-radius: 10px;
      padding: 10px 12px;
      display: grid;
      gap: 5px;
    }
    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 2px;
    }
    button, a {
      appearance: none;
      border: 1px solid rgba(255,255,255,.18);
      background: rgba(255,255,255,.06);
      color: var(--text);
      border-radius: 9px;
      padding: 10px 14px;
      font-size: 13px;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
    }
    button.primary {
      background: linear-gradient(180deg, var(--accent2) 0%, var(--accent) 100%);
      color: #081121;
      border-color: transparent;
    }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <h1>Não foi possível abrir o Messly</h1>
      <p>${reason}</p>
      <div class="meta">
        <p><strong>URL:</strong> ${safeRendererUrl}</p>
        ${safeErrorCode ? `<p><strong>Código:</strong> ${safeErrorCode}</p>` : ""}
        ${errorDescription ? `<p><strong>Detalhe:</strong> ${errorDescription}</p>` : ""}
        ${details ? `<p><strong>Diagnóstico:</strong> ${details}</p>` : ""}
      </div>
      <p class="warn">Verifique conexão/DNS/SSL e tente novamente.</p>
      <div class="actions">
        <button id="retry" class="primary">Tentar novamente</button>
        <a href="${safeRendererUrl}" target="_self" rel="noreferrer">Abrir URL</a>
      </div>
    </section>
  </main>
  <script>
    const retryButton = document.getElementById("retry");
    if (retryButton) {
      retryButton.addEventListener("click", () => {
        window.location.href = ${safeRendererUrlJs};
      });
    }
  </script>
</body>
</html>`;
}

function getStatusPanelWindow() {
  if (statusPanelWindowRef && !statusPanelWindowRef.isDestroyed()) {
    return statusPanelWindowRef;
  }

  const window = new BrowserWindow({
    width: 388,
    height: 430,
    minWidth: 388,
    minHeight: 430,
    maxWidth: 388,
    maxHeight: 430,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: false,
    backgroundColor: "#242b37",
    roundedCorners: true,
    movable: true,
    focusable: true,
    autoHideMenuBar: true,
    title: "",
    icon: CHILD_WINDOW_ICON_PATH || MAIN_WINDOW_ICON_PATH || process.execPath,
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

  window.on("close", (event) => {
    if (!updaterInstallGuardActive || isAppQuitting) {
      return;
    }
    event.preventDefault();
  });

  window.on("closed", () => {
    if (statusPanelWindowRef === window) {
      statusPanelWindowRef = null;
      statusPanelMode = null;
      statusPanelRenderKey = null;
      statusPanelPhase = STATUS_PANEL_PHASE.IDLE;
      statusPanelPhaseSinceMs = 0;
      resetStatusPanelProgressInterpolation();
    }
  });

  statusPanelWindowRef = window;
  return window;
}

function clearStatusPanelAutoHide() {
  if (statusPanelAutoHideTimer != null) {
    clearTimeout(statusPanelAutoHideTimer);
    statusPanelAutoHideTimer = null;
  }
}

function clearStatusPanelPhaseTransition() {
  if (statusPanelPhaseTransitionTimer != null) {
    clearTimeout(statusPanelPhaseTransitionTimer);
    statusPanelPhaseTransitionTimer = null;
  }
  statusPanelQueuedPhaseTransition = null;
}

function scheduleStatusPanelAutoHide(delayMs, mode) {
  clearStatusPanelAutoHide();
  if (!STATUS_PANEL_ENABLED) {
    return;
  }
  const parsedDelay = Number(delayMs);
  const safeDelay = Number.isFinite(parsedDelay) ? Math.max(150, Math.trunc(parsedDelay)) : 900;
  statusPanelAutoHideTimer = setTimeout(() => {
    statusPanelAutoHideTimer = null;
    hideStatusPanel({ mode, force: true });
  }, safeDelay);
}

function showStatusPanel(payload, mode = "generic") {
  if (!STATUS_PANEL_ENABLED) {
    return;
  }
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
    indeterminate: Boolean(sourcePayload.indeterminate),
  };
  if (!safePayload.title && !safePayload.subtitle) {
    safePayload.title = STATUS_PANEL_FALLBACK_TITLE;
    safePayload.subtitle = STATUS_PANEL_FALLBACK_SUBTITLE;
    safePayload.showProgressBar = true;
    safePayload.indeterminate = true;
    if (!Number.isFinite(safePayload.progressPercent) || safePayload.progressPercent <= 0) {
      safePayload.progressPercent = 16;
    }
  }
  clearStatusPanelAutoHide();
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
  clearStatusPanelAutoHide();
  clearStatusPanelPhaseTransition();
  const mode = typeof options === "string" ? options : options?.mode;
  const force = typeof options === "object" && options !== null && Boolean(options.force);
  const panelWindow = statusPanelWindowRef;
  if (!panelWindow || panelWindow.isDestroyed()) {
    statusPanelWindowRef = null;
    statusPanelMode = null;
    statusPanelRenderKey = null;
    statusPanelPhase = STATUS_PANEL_PHASE.IDLE;
    statusPanelPhaseSinceMs = 0;
    statusPanelDisplayProgressPercent = 0;
    statusPanelProgressInterpolationMode = "";
    return;
  }
  if (!force && mode && statusPanelMode && statusPanelMode !== mode) {
    return;
  }
  statusPanelMode = null;
  statusPanelRenderKey = null;
  statusPanelPhase = STATUS_PANEL_PHASE.IDLE;
  statusPanelPhaseSinceMs = 0;
  statusPanelDisplayProgressPercent = 0;
  statusPanelProgressInterpolationMode = "";
  panelWindow.destroy();
}

function isStartupStatusPanelLifecycleActive() {
  return Boolean(STATUS_PANEL_ENABLED && app.isPackaged && startupStatusPanelLifecycleActive);
}

function clearStartupStatusPanelHardStopTimer() {
  if (startupStatusPanelHardStopTimer != null) {
    clearTimeout(startupStatusPanelHardStopTimer);
    startupStatusPanelHardStopTimer = null;
  }
}

function armStartupStatusPanelHardStopTimer() {
  clearStartupStatusPanelHardStopTimer();
  if (!isStartupStatusPanelLifecycleActive()) {
    return;
  }
  startupStatusPanelHardStopTimer = setTimeout(() => {
    startupStatusPanelHardStopTimer = null;
    if (!isStartupStatusPanelLifecycleActive()) {
      return;
    }

    console.warn(`[electron] startup status panel hard timeout reached after ${STARTUP_STATUS_PANEL_HARD_TIMEOUT_MS}ms`);
    logStartupDiagnostic("startup-status-panel:hard-timeout", {
      timeoutMs: STARTUP_STATUS_PANEL_HARD_TIMEOUT_MS,
    }, "warn");
    completeStartupStatusPanelLifecycle("hard-timeout");
    hideStatusPanel({ force: true });

    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      ensureMainWindowBootstrapped();
      return;
    }
    if (mainWindowWaitingForFirstFrame && !mainWindowFirstFrameReady) {
      revealMainWindowAfterFirstFrame({
        startMinimized: false,
        surface: "startup-status-panel-hard-timeout",
      });
      return;
    }
    if (!mainWindow.isVisible() && !shouldStartMinimizedThisLaunch()) {
      mainWindow.show();
      mainWindow.focus();
    }
  }, STARTUP_STATUS_PANEL_HARD_TIMEOUT_MS);
}

function beginStartupStatusPanelLifecycle() {
  startupStatusPanelLifecycleActive = Boolean(STATUS_PANEL_ENABLED && app.isPackaged);
  armStartupStatusPanelHardStopTimer();
}

function completeStartupStatusPanelLifecycle(reason = "") {
  if (!startupStatusPanelLifecycleActive) {
    return;
  }
  startupStatusPanelLifecycleActive = false;
  clearStartupStatusPanelHardStopTimer();
  if (reason) {
    console.info(`[electron] startup status panel lifecycle closed: ${reason}`);
  }
  if (statusPanelWindowRef && !statusPanelWindowRef.isDestroyed()) {
    scheduleStatusPanelAutoHide(360);
  }
}

function normalizeStatusPanelPhaseName(rawPhase) {
  const candidate = String(rawPhase ?? "").trim().toLowerCase();
  for (const value of Object.values(STATUS_PANEL_PHASE)) {
    if (candidate === value) {
      return value;
    }
  }
  return STATUS_PANEL_PHASE.IDLE;
}

function clampStatusPanelProgress(rawValue) {
  const numericValue = Number(rawValue);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }
  return Math.max(0, Math.min(100, numericValue));
}

function resetStatusPanelProgressInterpolation() {
  statusPanelDisplayProgressPercent = 0;
  statusPanelProgressInterpolationMode = "";
}

function interpolateDownloadProgress(rawProgress) {
  const targetProgress = clampStatusPanelProgress(rawProgress);
  if (statusPanelProgressInterpolationMode !== STATUS_PANEL_PHASE.DOWNLOADING) {
    statusPanelProgressInterpolationMode = STATUS_PANEL_PHASE.DOWNLOADING;
    statusPanelDisplayProgressPercent = targetProgress;
    return statusPanelDisplayProgressPercent;
  }

  if (targetProgress <= statusPanelDisplayProgressPercent) {
    return statusPanelDisplayProgressPercent;
  }

  const delta = targetProgress - statusPanelDisplayProgressPercent;
  const easedStep = Math.max(0.7, delta * 0.56);
  statusPanelDisplayProgressPercent = Math.min(targetProgress, statusPanelDisplayProgressPercent + easedStep);
  if (targetProgress >= 99.5) {
    statusPanelDisplayProgressPercent = 100;
  }
  return statusPanelDisplayProgressPercent;
}

function formatStatusPanelDownloadProgressText(progressPercent, downloadedBytes, totalBytes, bytesPerSecond = 0) {
  const roundedPercent = Math.round(clampStatusPanelProgress(progressPercent));
  const downloaded = Number(downloadedBytes);
  const total = Number(totalBytes);
  if (!Number.isFinite(downloaded) || !Number.isFinite(total) || total <= 0) {
    const speedLabel = formatTransferRate(bytesPerSecond);
    return speedLabel ? `${roundedPercent}%  ${speedLabel}` : `${roundedPercent}%`;
  }
  if (total < STATUS_PANEL_PROGRESS_BYTES_VISIBILITY_THRESHOLD) {
    const speedLabel = formatTransferRate(bytesPerSecond);
    return speedLabel ? `${roundedPercent}%  ${speedLabel}` : `${roundedPercent}%`;
  }
  const progressLabel = `${roundedPercent}%  ${formatTransferBytes(downloaded)} / ${formatTransferBytes(total)}`;
  const speedLabel = formatTransferRate(bytesPerSecond);
  if (!speedLabel) {
    return progressLabel;
  }
  return `${progressLabel}  ${speedLabel}`;
}

function buildStatusPanelPhasePayload(phase, data = {}) {
  const copy = STATUS_PANEL_COPY_PT_BR[phase] ?? STATUS_PANEL_COPY_PT_BR[STATUS_PANEL_PHASE.LAUNCHING];
  const payload = {
    title: String(data.title ?? copy.title ?? "").trim(),
    subtitle: String(data.subtitle ?? copy.subtitle ?? "").trim(),
    detail: String(data.detail ?? "").trim(),
    progressText: String(data.progressText ?? "").trim(),
    progressPercent: clampStatusPanelProgress(data.progressPercent ?? copy.progressPercent ?? 0),
    showProgressBar: data.showProgressBar !== undefined ? Boolean(data.showProgressBar) : copy.showProgressBar !== false,
    showProgress: data.showProgress !== undefined ? Boolean(data.showProgress) : Boolean(copy.showProgress),
    indeterminate: data.indeterminate !== undefined ? Boolean(data.indeterminate) : Boolean(copy.indeterminate),
  };

  if (phase === STATUS_PANEL_PHASE.DOWNLOADING) {
    const smoothedProgress = interpolateDownloadProgress(payload.progressPercent);
    payload.progressPercent = smoothedProgress;
    if (!payload.progressText && payload.showProgress) {
      payload.progressText = formatStatusPanelDownloadProgressText(
        smoothedProgress,
        data.downloadedBytes ?? 0,
        data.totalBytes ?? 0,
        data.bytesPerSecond ?? 0,
      );
    }
  } else if (statusPanelProgressInterpolationMode === STATUS_PANEL_PHASE.DOWNLOADING) {
    resetStatusPanelProgressInterpolation();
  }

  if (payload.indeterminate && !payload.showProgress) {
    payload.progressText = "";
  }
  return payload;
}

function applyStatusPanelPhase(phase, data = {}) {
  const normalizedPhase = normalizeStatusPanelPhaseName(phase);
  if (normalizedPhase === STATUS_PANEL_PHASE.IDLE) {
    hideStatusPanel();
    return;
  }

  const payload = buildStatusPanelPhasePayload(normalizedPhase, data);
  showStatusPanel(payload, normalizedPhase);
}

function setStatusPanelPhase(phase, data = {}, options = {}) {
  const normalizedPhase = normalizeStatusPanelPhaseName(phase);
  if (normalizedPhase === STATUS_PANEL_PHASE.IDLE) {
    hideStatusPanel();
    return;
  }

  const forceTransition = Boolean(options.force);
  const nowMs = Date.now();
  const currentPhase = normalizeStatusPanelPhaseName(statusPanelPhase);

  if (currentPhase && currentPhase !== STATUS_PANEL_PHASE.IDLE && currentPhase !== normalizedPhase && !forceTransition) {
    const minVisibleMs = Number(STATUS_PANEL_MIN_VISIBLE_MS[currentPhase] ?? 0);
    const elapsedMs = Math.max(0, nowMs - Number(statusPanelPhaseSinceMs ?? 0));
    if (minVisibleMs > 0 && elapsedMs < minVisibleMs) {
      clearStatusPanelPhaseTransition();
      statusPanelQueuedPhaseTransition = {
        phase: normalizedPhase,
        data: data && typeof data === "object" ? { ...data } : {},
      };
      statusPanelPhaseTransitionTimer = setTimeout(() => {
        const queuedTransition = statusPanelQueuedPhaseTransition;
        clearStatusPanelPhaseTransition();
        if (!queuedTransition) {
          return;
        }
        setStatusPanelPhase(queuedTransition.phase, queuedTransition.data, {
          force: true,
        });
      }, Math.max(40, minVisibleMs - elapsedMs));
      return;
    }
  }

  clearStatusPanelPhaseTransition();
  statusPanelPhase = normalizedPhase;
  statusPanelPhaseSinceMs = nowMs;
  applyStatusPanelPhase(normalizedPhase, data);
}

function syncStatusPanelWithUpdaterStateV2(nextState) {
  if (!nextState || typeof nextState !== "object") {
    return;
  }
  if (!isStartupStatusPanelLifecycleActive()) {
    if (statusPanelWindowRef && !statusPanelWindowRef.isDestroyed()) {
      hideStatusPanel({ force: true });
    }
    return;
  }

  if (startupAutoUpdateGateExpired) {
    return;
  }

  const status = String(nextState.status ?? "").trim().toLowerCase();
  if (status === "checking") {
    updaterInstallGuardActive = false;
    setStatusPanelPhase(STATUS_PANEL_PHASE.CHECKING);
    return;
  }

  if (status === "available") {
    updaterInstallGuardActive = false;
    setStatusPanelPhase(STATUS_PANEL_PHASE.UPDATE_AVAILABLE, {
      detail: nextState.latestVersion ? `Versão ${String(nextState.latestVersion).trim()} disponível.` : "",
    });
    return;
  }

  if (status === "downloading") {
    updaterInstallGuardActive = false;
    setStatusPanelPhase(STATUS_PANEL_PHASE.DOWNLOADING, {
      progressPercent: Number(nextState.progressPercent ?? 0),
      downloadedBytes: Number(nextState.downloadedBytes ?? 0),
      totalBytes: Number(nextState.totalBytes ?? 0),
      bytesPerSecond: Number(nextState.bytesPerSecond ?? 0),
      showProgress: true,
      indeterminate: false,
    });
    updaterAutoInstallInFlight = false;
    hideWindowsForUpdateFlow();
    return;
  }

  if (status === "downloaded") {
    updaterInstallGuardActive = false;
    setStatusPanelPhase(STATUS_PANEL_PHASE.APPLYING, {
      detail: "Download concluído. Preparando instalação.",
      indeterminate: true,
    });
    hideWindowsForUpdateFlow();
    return;
  }

  if (status === "installing" || status === "applying" || status === "relaunching") {
    updaterInstallGuardActive = true;
    setStatusPanelPhase(
      status === "relaunching" ? STATUS_PANEL_PHASE.RELAUNCHING : STATUS_PANEL_PHASE.INSTALLING,
      {
        detail: "Não feche o aplicativo durante a instalação.",
      },
    );
    hideWindowsForUpdateFlow();
    return;
  }

  if (status === "unavailable") {
    updaterInstallGuardActive = false;
    updaterAutoInstallInFlight = false;
    if (mainWindowWaitingForFirstFrame && !mainWindowFirstFrameReady) {
      setStatusPanelPhase(STATUS_PANEL_PHASE.LOADING_SHELL);
      return;
    }
    if (mainWindowFirstFrameReady) {
      restoreWindowsAfterUpdateFlow();
      return;
    }
    setStatusPanelPhase(STATUS_PANEL_PHASE.READY, {
      title: "Abrindo Messly",
      subtitle: "Inicializando interface",
      showProgressBar: true,
      showProgress: false,
      indeterminate: true,
    });
    scheduleStatusPanelAutoHide(760, STATUS_PANEL_PHASE.READY);
    restoreWindowsAfterUpdateFlow();
    ensureMainWindowBootstrapped();
    return;
  }

  if (status === "error" || status === "failed") {
    updaterInstallGuardActive = false;
    updaterAutoInstallInFlight = false;
    if (mainWindowWaitingForFirstFrame && !mainWindowFirstFrameReady) {
      setStatusPanelPhase(STATUS_PANEL_PHASE.LOADING_SHELL, {
        title: "Carregando Messly",
        subtitle: "Inicializando interface",
        showProgressBar: true,
        showProgress: false,
        indeterminate: true,
      }, {
        force: true,
      });
      return;
    }
    hideStatusPanel({ force: true });
    restoreWindowsAfterUpdateFlow();
    ensureMainWindowBootstrapped();
    return;
  }

  if (status === "disabled" || status === "idle" || status === "ready" || status === "retrying") {
    updaterInstallGuardActive = false;
    updaterAutoInstallInFlight = false;
    if (mainWindowWaitingForFirstFrame && !mainWindowFirstFrameReady) {
      setStatusPanelPhase(STATUS_PANEL_PHASE.LOADING_SHELL);
      return;
    }
    hideStatusPanel();
    restoreWindowsAfterUpdateFlow();
    ensureMainWindowBootstrapped();
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

function getStoredRefreshTokenFromSecureStorage() {
  const scopedToken = String(getSecureAuthStorageValue(PROJECT_SCOPED_REFRESH_TOKEN_STORAGE_KEY) ?? "").trim();
  if (scopedToken) {
    return scopedToken;
  }

  if (PROJECT_SCOPED_REFRESH_TOKEN_STORAGE_KEY !== LEGACY_REFRESH_TOKEN_STORAGE_KEY) {
    const legacyToken = String(getSecureAuthStorageValue(LEGACY_REFRESH_TOKEN_STORAGE_KEY) ?? "").trim();
    if (legacyToken) {
      try {
        setSecureAuthStorageValue(PROJECT_SCOPED_REFRESH_TOKEN_STORAGE_KEY, legacyToken);
        removeSecureAuthStorageValue(LEGACY_REFRESH_TOKEN_STORAGE_KEY);
      } catch {
        // Best effort migration only.
      }
      return legacyToken;
    }
  }

  return null;
}

function setStoredRefreshTokenInSecureStorage(rawToken) {
  const token = String(rawToken ?? "");
  const result = setSecureAuthStorageValue(PROJECT_SCOPED_REFRESH_TOKEN_STORAGE_KEY, token);
  if (PROJECT_SCOPED_REFRESH_TOKEN_STORAGE_KEY !== LEGACY_REFRESH_TOKEN_STORAGE_KEY) {
    removeSecureAuthStorageValue(LEGACY_REFRESH_TOKEN_STORAGE_KEY);
  }
  return result;
}

function clearStoredRefreshTokenInSecureStorage() {
  const scopedResult = removeSecureAuthStorageValue(PROJECT_SCOPED_REFRESH_TOKEN_STORAGE_KEY);
  if (PROJECT_SCOPED_REFRESH_TOKEN_STORAGE_KEY === LEGACY_REFRESH_TOKEN_STORAGE_KEY) {
    return scopedResult;
  }

  const legacyResult = removeSecureAuthStorageValue(LEGACY_REFRESH_TOKEN_STORAGE_KEY);
  return {
    removed: Boolean(scopedResult?.removed || legacyResult?.removed),
    persistent: Boolean(scopedResult?.persistent ?? legacyResult?.persistent),
  };
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

function getConfiguredAppApiBaseUrl() {
  const configuredAppApiUrl = String(process.env.VITE_MESSLY_API_URL ?? "").trim();
  const configuredAuthApiUrl = String(process.env.VITE_MESSLY_AUTH_API_URL ?? "").trim();
  return normalizePublicApiBaseUrl(configuredAppApiUrl || configuredAuthApiUrl || DEFAULT_PUBLIC_API_BASE_URL);
}

function normalizePublicApiBaseUrl(rawValue) {
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!value) {
    return DEFAULT_PUBLIC_API_BASE_URL;
  }

  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.trim().toLowerCase();
    if (hostname === "api.messly.site" || hostname === "messly.site" || hostname === "www.messly.site") {
      parsed.hostname = "gateway.messly.site";
      parsed.port = "";

      const normalizedPath = parsed.pathname.replace(/\/+$/, "");
      if (!normalizedPath || normalizedPath === "/" || normalizedPath === "/api") {
        parsed.pathname = "";
      } else if (normalizedPath.startsWith("/api/")) {
        const withoutApiPrefix = normalizedPath.slice(4);
        parsed.pathname = withoutApiPrefix || "/";
      } else {
        parsed.pathname = normalizedPath;
      }
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return value.replace(/\/+$/, "") || DEFAULT_PUBLIC_API_BASE_URL;
  }
}

function rewriteLegacyPublicApiRequestUrl(rawValue) {
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.trim().toLowerCase();
    const normalizedPath = parsed.pathname.replace(/\/+$/, "");
    const isLegacyApiHost = hostname === "api.messly.site";
    const isLegacyApiPathOnWebHost =
      (hostname === "messly.site" || hostname === "www.messly.site") &&
      (normalizedPath === "/api" || normalizedPath.startsWith("/api/"));

    if (!isLegacyApiHost && !isLegacyApiPathOnWebHost) {
      return null;
    }

    parsed.hostname = "gateway.messly.site";
    parsed.port = "";

    if (isLegacyApiPathOnWebHost) {
      if (normalizedPath === "/api") {
        parsed.pathname = "/";
      } else {
        const withoutApiPrefix = normalizedPath.slice(4);
        parsed.pathname = withoutApiPrefix || "/";
      }
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizePublicGatewayUrl(rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!value) {
    return "";
  }

  const candidate = /^[a-z][a-z0-9+\-.]*:\/\//i.test(value) ? value : `wss://${value}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === "http:") {
      parsed.protocol = "ws:";
    } else if (parsed.protocol === "https:") {
      parsed.protocol = "wss:";
    }
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return "";
    }

    const hostname = parsed.hostname.trim().toLowerCase();
    if (hostname === "www.messly.site" || (app.isPackaged && hostname === "messly.site")) {
      parsed.hostname = "gateway.messly.site";
      parsed.port = "";
    }

    parsed.search = "";
    parsed.hash = "";
    const trimmedPath = parsed.pathname.replace(/\/+$/, "");
    if (!trimmedPath || trimmedPath === "/") {
      parsed.pathname = "/gateway";
    } else {
      parsed.pathname = trimmedPath.startsWith("/") ? trimmedPath : `/${trimmedPath}`;
    }

    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function getConfiguredWebOrigin() {
  const configuredWebOrigin = String(process.env.VITE_MESSLY_ASSETS_URL ?? "").trim();
  if (configuredWebOrigin) {
    try {
      const parsedConfigured = new URL(configuredWebOrigin);
      parsedConfigured.pathname = "";
      parsedConfigured.search = "";
      parsedConfigured.hash = "";
      return parsedConfigured.toString().replace(/\/+$/, "") || DEFAULT_PUBLIC_WEB_ORIGIN;
    } catch {
      // Fallback below.
    }
  }

  const apiBaseUrl = getConfiguredAppApiBaseUrl();
  try {
    const parsed = new URL(apiBaseUrl);
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "") || DEFAULT_PUBLIC_WEB_ORIGIN;
  } catch {
    return DEFAULT_PUBLIC_WEB_ORIGIN;
  }
}

function buildStartupSnapshot() {
  const refreshToken = String(getStoredRefreshTokenFromSecureStorage() ?? "").trim();
  const hiddenState = loadHiddenDirectMessagesState();
  const scopeMap =
    hiddenState?.hiddenConversationIdsByScope && typeof hiddenState.hiddenConversationIdsByScope === "object"
      ? hiddenState.hiddenConversationIdsByScope
      : {};

  let hiddenConversationCount = 0;
  for (const conversationIds of Object.values(scopeMap)) {
    hiddenConversationCount += normalizeHiddenDirectMessageConversationIds(conversationIds).length;
  }

  const rawConfiguredGatewayUrl = String(process.env.VITE_MESSLY_GATEWAY_URL ?? "").trim();
  const configuredGatewayUrl = normalizePublicGatewayUrl(rawConfiguredGatewayUrl);
  const fallbackGatewayUrl = normalizePublicGatewayUrl(DEFAULT_PUBLIC_GATEWAY_URL) || DEFAULT_PUBLIC_GATEWAY_URL;
  const selectedGatewayUrl = configuredGatewayUrl || fallbackGatewayUrl;
  if (rawConfiguredGatewayUrl && !configuredGatewayUrl) {
    console.warn("[electron] invalid gateway url in startup snapshot config, using fallback", {
      received: rawConfiguredGatewayUrl,
      fallback: fallbackGatewayUrl,
    });
  }
  const configuredAuthApiUrl = normalizePublicApiBaseUrl(String(process.env.VITE_MESSLY_AUTH_API_URL ?? "").trim());
  const configuredAppApiUrl = getConfiguredAppApiBaseUrl();
  const shellOrigin = app.isPackaged
    ? getProductionRendererOrigin()
    : (() => {
        try {
          return new URL(process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL || DEV_SERVER_URL).origin;
        } catch {
          return null;
        }
      })();

  return {
    generatedAt: new Date().toISOString(),
    appVersion: String(app.getVersion?.() ?? "0.0.0"),
    hasRefreshToken: Boolean(refreshToken),
    secureStorageAvailable: canPersistSecureAuthStorage(),
    windowsSettings: { ...loadWindowsBehaviorSettings() },
    apiConfig: {
      supabaseUrl: String(process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "").trim() || null,
      gatewayUrl: selectedGatewayUrl,
      authApiUrl: configuredAuthApiUrl || configuredAppApiUrl || DEFAULT_PUBLIC_API_BASE_URL,
      appApiUrl: configuredAppApiUrl || DEFAULT_PUBLIC_API_BASE_URL,
      webOrigin: getConfiguredWebOrigin(),
      shellOrigin,
      mediaProxyUrl: `${configuredAppApiUrl || DEFAULT_PUBLIC_API_BASE_URL}/media/upload/profile`,
    },
    cacheHints: {
      hiddenScopeCount: Object.keys(scopeMap).length,
      hiddenConversationCount,
    },
    startupPerformance: getMainStartupPerfSnapshot(),
  };
}

function getMainWindow() {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    return mainWindowRef;
  }
  mainWindowRef = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ?? null;
  return mainWindowRef;
}

function clearMainWindowFirstFrameFallbackTimer() {
  if (mainWindowFirstFrameFallbackTimer != null) {
    clearTimeout(mainWindowFirstFrameFallbackTimer);
    mainWindowFirstFrameFallbackTimer = null;
  }
}

function scheduleMainWindowFirstFrameFallback(mainWindow, startMinimized) {
  clearMainWindowFirstFrameFallbackTimer();
  if (!mainWindow || mainWindow.isDestroyed() || startMinimized) {
    return;
  }
  logStartupDiagnostic("renderer:first-frame-fallback-armed", {
    timeoutMs: MAIN_WINDOW_FIRST_FRAME_TIMEOUT_MS,
    startMinimized,
  }, "debug");

  mainWindowFirstFrameFallbackTimer = setTimeout(async () => {
    mainWindowFirstFrameFallbackTimer = null;
    if (!mainWindowWaitingForFirstFrame || mainWindowFirstFrameReady) {
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    const webContents = mainWindow.webContents;
    const currentUrl = webContents && !webContents.isDestroyed() ? String(webContents.getURL() ?? "").trim() : "";
    const isStillLoading = Boolean(webContents && !webContents.isDestroyed() && webContents.isLoadingMainFrame());
    const isBlankUrl = !currentUrl || currentUrl === "about:blank";
    const isDataUrl = currentUrl.startsWith("data:text/html");
    logStartupDiagnostic("renderer:first-frame-fallback-fired", {
      currentUrl: currentUrl || null,
      isStillLoading,
      isBlankUrl,
      isDataUrl,
    }, "warn");

    if (isBlankUrl || isStillLoading) {
      showMainWindowRendererLoadFailure(mainWindow, {
        rendererUrl: app.isPackaged ? getExpectedProductionRendererUrl() : DEV_SERVER_URL,
        validatedURL: currentUrl,
        reason: "Tempo limite ao iniciar a interface.",
        details: isStillLoading ? "Carregamento principal excedeu o tempo esperado." : "A janela permaneceu em branco.",
      });
      return;
    }

    if (isDataUrl) {
      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }
      mainWindow.focus();
      logStartupDiagnostic("renderer:first-frame-fallback-data-url-visible", {
        currentUrl: currentUrl || null,
      }, "warn");
      return;
    }

    let domSnapshot = null;
    if (webContents && !webContents.isDestroyed()) {
      try {
        domSnapshot = await webContents.executeJavaScript(
          `(() => {
            const root = document.getElementById("root");
            const body = document.body;
            const rootChildCount = root ? root.childElementCount : 0;
            const bodyChildCount = body ? body.childElementCount : 0;
            const bodyTextLength = body && typeof body.innerText === "string" ? body.innerText.trim().length : 0;
            return { rootChildCount, bodyChildCount, bodyTextLength };
          })();`,
          true,
        );
      } catch {}
    }

    const rootChildCount = Number(domSnapshot?.rootChildCount ?? 0);
    const bodyChildCount = Number(domSnapshot?.bodyChildCount ?? 0);
    const bodyTextLength = Number(domSnapshot?.bodyTextLength ?? 0);
    const hasRenderableDom = rootChildCount > 0 || bodyChildCount > 1 || bodyTextLength > 0;
    if (!hasRenderableDom) {
      showMainWindowRendererLoadFailure(mainWindow, {
        rendererUrl: app.isPackaged ? getExpectedProductionRendererUrl() : DEV_SERVER_URL,
        validatedURL: currentUrl,
        reason: "A interface não renderizou conteúdo visível.",
        details: `DOM snapshot: root=${rootChildCount}, bodyChildren=${bodyChildCount}, text=${bodyTextLength}`,
      });
      return;
    }

    console.warn("[electron] renderer first-frame timeout reached, forcing main window reveal", {
      currentUrl: currentUrl || null,
      isStillLoading,
    });
    logStartupDiagnostic("renderer:first-frame-fallback-force-reveal", {
      currentUrl: currentUrl || null,
      isStillLoading,
    }, "warn");
    revealMainWindowAfterFirstFrame({
      startMinimized: false,
      surface: "first-frame-timeout-fallback",
    });
  }, MAIN_WINDOW_FIRST_FRAME_TIMEOUT_MS);
}

function revealMainWindowAfterFirstFrame(options = {}) {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  const startMinimized =
    typeof options.startMinimized === "boolean" ? options.startMinimized : shouldStartMinimizedThisLaunch();

  clearMainWindowFirstFrameFallbackTimer();
  startupUpdaterBlockTimedOut = false;
  mainWindowWaitingForFirstFrame = false;
  mainWindowFirstFrameReady = true;
  logStartupDiagnostic("window:reveal-after-first-frame", {
    startMinimized,
    surface: String(options?.surface ?? "").trim() || null,
  });

  if (startMinimized) {
    if (loadWindowsBehaviorSettings().closeToTray) {
      void createAppTray();
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.minimize();
    }
    hideStatusPanel();
    completeStartupStatusPanelLifecycle("start-minimized");
    return true;
  }

  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  mainWindow.focus();
  markMainStartupPerf("main:window-revealed", {
    startMinimized,
  });
  measureMainStartupPerf("main_entry_to_window_reveal", "main:entry", "main:window-revealed", {
    startMinimized,
  });
  measureMainStartupPerf("main_when_ready_to_window_reveal", "main:when-ready", "main:window-revealed", {
    startMinimized,
  });
  if (isStartupStatusPanelLifecycleActive()) {
    setStatusPanelPhase(STATUS_PANEL_PHASE.READY, {
      title: "Abrindo Messly",
      subtitle: "Inicializando interface",
      showProgressBar: true,
      showProgress: false,
      indeterminate: true,
    }, {
      force: true,
    });
    scheduleStatusPanelAutoHide(180, STATUS_PANEL_PHASE.READY);
    completeStartupStatusPanelLifecycle("main-window-revealed");
  } else {
    hideStatusPanel();
  }
  return true;
}

function handleRendererFirstFrameReady(event, payload) {
  const senderWindow = BrowserWindow.fromWebContents(event.sender) ?? null;
  const mainWindow = getMainWindow();
  if (!senderWindow || !mainWindow || senderWindow !== mainWindow) {
    logStartupDiagnostic("renderer:first-frame-ignored", {
      reason: "sender-not-main-window",
    }, "debug");
    return;
  }

  if (mainWindowFirstFrameReady) {
    logStartupDiagnostic("renderer:first-frame-ignored", {
      reason: "already-ready",
      surface: payload?.surface ?? null,
      route: payload?.route ?? null,
    }, "debug");
    return;
  }

  logStartupDiagnostic("renderer:first-frame-ready", {
    surface: payload?.surface ?? null,
    route: payload?.route ?? null,
    bootstrapPhase: payload?.bootstrapPhase ?? null,
  });

  markMainStartupPerf("main:renderer-first-frame", {
    surface: payload?.surface ?? null,
    route: payload?.route ?? null,
  });
  measureMainStartupPerf("main_entry_to_renderer_first_frame", "main:entry", "main:renderer-first-frame", {
    surface: payload?.surface ?? null,
    route: payload?.route ?? null,
  });

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

function ensureMainWindowBootstrapped() {
  if (isAppQuitting) {
    return;
  }
  if (getMainWindow()) {
    return;
  }
  createMainWindow();
}

function showMainWindowRendererLoadFailure(mainWindow, context = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  clearMainWindowFirstFrameFallbackTimer();
  startupUpdaterBlockTimedOut = false;
  mainWindowWaitingForFirstFrame = false;
  mainWindowFirstFrameReady = true;
  hideStatusPanel();
  completeStartupStatusPanelLifecycle("renderer-load-failure");

  const rendererUrl = String(context.rendererUrl ?? getExpectedProductionRendererUrl()).trim() || getExpectedProductionRendererUrl();
  const validatedUrl = String(context.validatedURL ?? "").trim();
  const errorCode = Number.isFinite(Number(context.errorCode)) ? Number(context.errorCode) : null;
  const errorDescription = String(context.errorDescription ?? "").trim();
  const reason = String(context.reason ?? "Falha ao carregar a interface.").trim() || "Falha ao carregar a interface.";
  const details = String(context.details ?? "").trim();

  console.error("[electron] main renderer load failure", {
    rendererUrl,
    validatedURL: validatedUrl || null,
    errorCode,
    errorDescription: errorDescription || null,
    reason,
    details: details || null,
  });
  logStartupDiagnostic("renderer:load-failure-screen", {
    rendererUrl,
    validatedURL: validatedUrl || null,
    errorCode,
    errorDescription: errorDescription || null,
    reason,
    details: details || null,
  }, "error");

  const html = buildRendererLoadFailureHtml({
    rendererUrl,
    validatedURL: validatedUrl,
    errorCode,
    errorDescription,
    reason,
    details,
  });
  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

  void mainWindow.loadURL(dataUrl).catch(() => {});
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  mainWindow.focus();
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

function queueIncomingVoiceCallNotification(payload) {
  return getNotificationManager().notifyCall(payload);
}

async function notifyMessageHandler(_event, payload) {
  return queueConversationMessageNotification(payload);
}

async function notifyCallHandler(_event, payload) {
  return queueIncomingVoiceCallNotification(payload);
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

  const trayIconPathCandidates = Array.from(
    new Set(
      [
        TRAY_ICON_PATH,
        MAIN_WINDOW_ICON_PATH,
        CHILD_WINDOW_ICON_PATH,
        APP_NOTIFICATION_ICON_ICO_PATH,
        APP_NOTIFICATION_ICON_PNG_PATH,
        resolvePackagedElectronIconPath("messly.ico") || null,
        process.execPath,
      ]
        .map((candidate) => (typeof candidate === "string" ? candidate.trim() : ""))
        .filter(Boolean),
    ),
  );

  let trayIconImage = trayIconImageCache;
  if (!trayIconImage || trayIconImage.isEmpty()) {
    for (const candidate of trayIconPathCandidates) {
      try {
        if (candidate !== process.execPath && !fs.existsSync(candidate)) {
          continue;
        }
        const nextImage = await buildTrayIconImage(candidate);
        if (nextImage && !nextImage.isEmpty()) {
          trayIconImage = nextImage;
          trayIconImageCache = nextImage;
          console.info(`[electron] tray icon selected: ${candidate}`);
          break;
        }
      } catch {}
    }
  }

  if ((!trayIconImage || trayIconImage.isEmpty()) && process.platform === "win32" && typeof app.getFileIcon === "function") {
    try {
      const executableIcon = await app.getFileIcon(process.execPath, { size: "normal" });
      if (executableIcon && !executableIcon.isEmpty()) {
        trayIconImage = trimTransparentEdges(executableIcon).resize({
          width: 24,
          height: 24,
          quality: "best",
        });
        trayIconImageCache = trayIconImage;
        console.info("[electron] tray icon selected from executable metadata");
      }
    } catch {}
  }

  const trayIcon = trayIconImage;
  if (!trayIcon || trayIcon.isEmpty()) {
    console.error("[electron] tray icon creation aborted: no valid icon source", {
      candidates: trayIconPathCandidates,
    });
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

function pushUpdaterStateToRendererWindows(nextState) {
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

function flushQueuedUpdaterState() {
  if (!updaterBroadcastQueuedState) {
    updaterBroadcastThrottleTimer = null;
    return;
  }
  const queuedState = updaterBroadcastQueuedState;
  updaterBroadcastQueuedState = null;
  updaterBroadcastThrottleTimer = null;
  updaterBroadcastLastAtMs = Date.now();
  pushUpdaterStateToRendererWindows(queuedState);
}

function broadcastUpdaterState(nextState) {
  const status = String(nextState?.status ?? "").trim().toLowerCase();
  if (status === "downloading") {
    updaterBroadcastQueuedState = nextState;
    const elapsedMs = Math.max(0, Date.now() - Number(updaterBroadcastLastAtMs || 0));
    if (elapsedMs >= 130 && !updaterBroadcastThrottleTimer) {
      flushQueuedUpdaterState();
      return;
    }
    if (!updaterBroadcastThrottleTimer) {
      const delayMs = Math.max(40, 130 - elapsedMs);
      updaterBroadcastThrottleTimer = setTimeout(() => {
        flushQueuedUpdaterState();
      }, delayMs);
    }
    return;
  }

  if (updaterBroadcastThrottleTimer) {
    clearTimeout(updaterBroadcastThrottleTimer);
    updaterBroadcastThrottleTimer = null;
  }
  updaterBroadcastQueuedState = null;
  updaterBroadcastLastAtMs = Date.now();
  pushUpdaterStateToRendererWindows(nextState);
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

function readBoundedIntegerEnv(rawValue, fallbackValue, minValue = Number.MIN_SAFE_INTEGER, maxValue = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(rawValue ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) {
    return fallbackValue;
  }
  return clampNumber(parsed, minValue, maxValue);
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
  const managedByExternalLauncher = readBooleanEnvFlag(process.env.MESSLY_EXTERNAL_LAUNCHER, false);
  if (managedByExternalLauncher) {
    logStartupDiagnostic("updater:managed-by-launcher", {
      managedByExternalLauncher,
    });
    return createDisabledUpdater("Atualizacoes gerenciadas pelo Messly Launcher.");
  }

  const enableInDev = readBooleanEnvFlag(process.env.AUTO_UPDATE_ENABLE_IN_DEV, false);
  if (!app.isPackaged && !enableInDev) {
    logStartupDiagnostic("updater:disabled-in-dev", {
      appIsPackaged: app.isPackaged,
      enableInDev,
    });
    return createDisabledUpdater("Atualizador desativado no modo desenvolvimento.");
  }

  try {
    const updater = createElectronUpdaterAdapter({
      app,
    });
    logStartupDiagnostic("updater:initialized", {
      appIsPackaged: app.isPackaged,
      adapter: "electron-updater",
    });
    return updater;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "unknown");
    console.warn(`[updater] Falha ao iniciar o updater oficial: ${message}`);
    logStartupDiagnostic("updater:initialize-failed", {
      message,
    }, "warn");
    return createDisabledUpdater("Não foi possível inicializar o sistema de atualização.");
  }
}

function waitForTimeout(delayMs) {
  const parsedDelay = Number(delayMs);
  const safeDelay = Number.isFinite(parsedDelay) ? Math.max(0, Math.trunc(parsedDelay)) : 0;
  if (safeDelay <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, safeDelay);
  });
}

async function runWithTimeout(taskPromise, timeoutMs, timeoutMessage) {
  const normalizedTimeout = Number(timeoutMs);
  const safeTimeoutMs = Number.isFinite(normalizedTimeout) ? Math.max(1_000, Math.trunc(normalizedTimeout)) : 0;
  if (safeTimeoutMs <= 0) {
    return taskPromise;
  }

  let timeoutHandle = null;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(timeoutMessage || `Operação excedeu ${safeTimeoutMs}ms.`));
      }, safeTimeoutMs);
    });
    return await Promise.race([taskPromise, timeoutPromise]);
  } finally {
    if (timeoutHandle != null) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  }
}

function getUpdaterStateStatus(state) {
  return String(
    state?.status ??
      appUpdater?.getState?.()?.status ??
      "",
  )
    .trim()
    .toLowerCase();
}

function buildStartupUpdateRetryDelayMs(attemptNumber) {
  const attemptIndex = Math.max(0, Number(attemptNumber) || 0);
  const candidate = STARTUP_AUTO_UPDATE_RETRY_BASE_DELAY_MS * (2 ** attemptIndex);
  return Math.min(STARTUP_AUTO_UPDATE_RETRY_MAX_DELAY_MS, Math.max(250, Math.trunc(candidate)));
}

async function runStartupUpdateStepWithRetry(stepLabel, maxAttempts, executeStep, timeoutPerAttemptMs = 0) {
  const safeMaxAttempts = Math.max(1, Number(maxAttempts) || 1);
  const safeStepLabel = String(stepLabel ?? "").trim() || "Atualização";
  let attempt = 0;

  while (attempt < safeMaxAttempts) {
    if (startupAutoUpdateGateExpired) {
      logStartupDiagnostic("updater:step-skipped-gate-expired", {
        stepLabel: safeStepLabel,
      }, "warn");
      return null;
    }
    try {
      const attemptNumber = attempt + 1;
      logStartupDiagnostic("updater:step-attempt", {
        stepLabel: safeStepLabel,
        attempt: attemptNumber,
        maxAttempts: safeMaxAttempts,
        timeoutPerAttemptMs,
      });
      const result = await runWithTimeout(
        executeStep(),
        timeoutPerAttemptMs,
        `${safeStepLabel} excedeu ${timeoutPerAttemptMs}ms.`,
      );
      logStartupDiagnostic("updater:step-attempt-succeeded", {
        stepLabel: safeStepLabel,
        attempt: attemptNumber,
        maxAttempts: safeMaxAttempts,
      });
      return result;
    } catch (error) {
      attempt += 1;
      const isFinalAttempt = attempt >= safeMaxAttempts;
      const message = error instanceof Error ? error.message : String(error ?? "Falha desconhecida.");
      logStartupDiagnostic("updater:step-attempt-failed", {
        stepLabel: safeStepLabel,
        attempt,
        maxAttempts: safeMaxAttempts,
        message,
        isFinalAttempt,
      }, "warn");
      if (isFinalAttempt) {
        throw error;
      }

      const retryAttemptNumber = attempt + 1;
      const delayMs = buildStartupUpdateRetryDelayMs(attempt - 1);
      if (isStartupStatusPanelLifecycleActive()) {
        setStatusPanelPhase(
          STATUS_PANEL_PHASE.RETRYING,
          {
            title: "Tentando novamente",
            subtitle: `${safeStepLabel} (${retryAttemptNumber}/${safeMaxAttempts})`,
            detail: message || "A conexão oscilou. Vamos tentar novamente.",
            indeterminate: true,
            showProgressBar: true,
          },
          {
            force: true,
          },
        );
      }
      console.warn(`[updater] ${safeStepLabel} falhou na tentativa ${attempt}/${safeMaxAttempts}: ${message}`);
      await waitForTimeout(delayMs);
      if (startupAutoUpdateGateExpired) {
        return null;
      }
    }
  }
  return null;
}

async function runStartupAutoUpdateIfEnabled() {
  if (startupAutoUpdatePromise) {
    return startupAutoUpdatePromise;
  }

  if (!app.isPackaged || !appUpdater) {
    logStartupDiagnostic("updater:startup-skipped", {
      appIsPackaged: app.isPackaged,
      hasUpdater: Boolean(appUpdater),
    }, "debug");
    return;
  }

  const autoInstallOnStartup = readBooleanEnvFlag(process.env.AUTO_UPDATE_INSTALL_ON_STARTUP, true);
  if (!autoInstallOnStartup) {
    logStartupDiagnostic("updater:startup-auto-install-disabled", {});
    return;
  }

  startupAutoUpdatePromise = (async () => {
    try {
      startupAutoUpdateGateExpired = false;
      updaterAutoInstallInFlight = false;
      updaterInstallGuardActive = false;
      logStartupDiagnostic("updater:startup-sequence-begin", {
        blockTimeoutMs: STARTUP_AUTO_UPDATE_BLOCK_TIMEOUT_MS,
        checkRetryMax: STARTUP_AUTO_UPDATE_CHECK_RETRY_MAX,
        downloadRetryMax: STARTUP_AUTO_UPDATE_DOWNLOAD_RETRY_MAX,
        checkStepTimeoutMs: STARTUP_AUTO_UPDATE_CHECK_STEP_TIMEOUT_MS,
        downloadStepTimeoutMs: STARTUP_AUTO_UPDATE_DOWNLOAD_STEP_TIMEOUT_MS,
      });

      const checkedState = await runStartupUpdateStepWithRetry(
        "Verificando atualizações",
        STARTUP_AUTO_UPDATE_CHECK_RETRY_MAX,
        async () => appUpdater.checkForUpdates(),
        STARTUP_AUTO_UPDATE_CHECK_STEP_TIMEOUT_MS,
      );
      if (startupAutoUpdateGateExpired) {
        logStartupDiagnostic("updater:startup-check-aborted", {
          reason: "gate-expired-after-check",
        }, "warn");
        return;
      }
      const checkedStatus = getUpdaterStateStatus(checkedState);
      logStartupDiagnostic("updater:startup-check-finished", {
        checkedStatus,
        latestVersion: checkedState?.latestVersion ?? null,
      });
      if (checkedStatus !== "available") {
        return;
      }

      if (isStartupStatusPanelLifecycleActive()) {
        setStatusPanelPhase(
          STATUS_PANEL_PHASE.UPDATE_AVAILABLE,
          {
            detail: checkedState?.latestVersion
              ? `Versão ${String(checkedState.latestVersion).trim()} encontrada.`
              : "",
          },
          { force: true },
        );
      }

      await runStartupUpdateStepWithRetry(
        "Baixando atualização",
        STARTUP_AUTO_UPDATE_DOWNLOAD_RETRY_MAX,
        async () => appUpdater.downloadUpdate(),
        STARTUP_AUTO_UPDATE_DOWNLOAD_STEP_TIMEOUT_MS,
      );
      if (startupAutoUpdateGateExpired) {
        logStartupDiagnostic("updater:startup-download-aborted", {
          reason: "gate-expired-after-download",
        }, "warn");
        return;
      }

      const resolvedStatus = getUpdaterStateStatus(appUpdater?.getState?.());
      logStartupDiagnostic("updater:startup-download-finished", {
        resolvedStatus,
      });
      if (resolvedStatus !== "downloaded") {
        return;
      }

      hideWindowsForUpdateFlow();
      updaterAutoInstallInFlight = true;
      updaterInstallGuardActive = true;

      setStatusPanelPhase(
        STATUS_PANEL_PHASE.APPLYING,
        {
          title: "Preparando atualização",
          subtitle: "Aplicando pacote baixado",
          detail: "Validando arquivos para instalação.",
          indeterminate: true,
        },
        {
          force: true,
        },
      );
      await waitForTimeout(420);

      setStatusPanelPhase(
        STATUS_PANEL_PHASE.INSTALLING,
        {
          title: "Instalando atualização",
          subtitle: "Não feche o aplicativo",
          detail: "A instalação está em andamento.",
          indeterminate: true,
        },
        {
          force: true,
        },
      );
      await waitForTimeout(480);

      setStatusPanelPhase(
        STATUS_PANEL_PHASE.RELAUNCHING,
        {
          title: "Atualização concluída",
          subtitle: "Reiniciando aplicativo",
          indeterminate: true,
        },
        {
          force: true,
        },
      );

      await appUpdater.installUpdate();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "unknown");
      console.warn(`[updater] Startup auto-update failed: ${message}`);
      logStartupDiagnostic("updater:startup-sequence-failed", {
        message,
      }, "warn");
      updaterAutoInstallInFlight = false;
      updaterInstallGuardActive = false;
      if (isStartupStatusPanelLifecycleActive()) {
        setStatusPanelPhase(
          STATUS_PANEL_PHASE.FAILED,
          {
            title: "Falha ao atualizar",
            subtitle: "Abrindo a versão atual",
            detail: message || "Não foi possível concluir a atualização automática.",
            showProgressBar: true,
            showProgress: false,
            indeterminate: false,
          },
          {
            force: true,
          },
        );
        scheduleStatusPanelAutoHide(1_250, STATUS_PANEL_PHASE.FAILED);
      }
      restoreWindowsAfterUpdateFlow();
    } finally {
      logStartupDiagnostic("updater:startup-sequence-finished", {
        startupAutoUpdateGateExpired,
        updaterStatus: getUpdaterStateStatus(appUpdater?.getState?.()),
      });
      updaterAutoInstallInFlight = false;
      if (!isAppQuitting) {
        const updaterStatus = getUpdaterStateStatus(appUpdater?.getState?.());
        const shouldKeepInstallGuard =
          updaterStatus === "installing" || updaterStatus === "applying" || updaterStatus === "relaunching";
        if (!shouldKeepInstallGuard) {
          updaterInstallGuardActive = false;
        }
      }
    }
  })().finally(() => {
    startupAutoUpdatePromise = null;
  });

  return startupAutoUpdatePromise;
}

async function runStartupAutoUpdateWithGuardTimeout() {
  if (!app.isPackaged) {
    logStartupDiagnostic("updater:startup-gate-skipped", {
      appIsPackaged: app.isPackaged,
    }, "debug");
    return;
  }

  logStartupDiagnostic("updater:startup-gate-begin", {
    blockTimeoutMs: STARTUP_AUTO_UPDATE_BLOCK_TIMEOUT_MS,
  });
  startupAutoUpdateGateExpired = false;
  startupUpdaterBlockTimedOut = false;
  let timeoutHandle = null;
  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => {
      resolve("timeout");
    }, STARTUP_AUTO_UPDATE_BLOCK_TIMEOUT_MS);
  });

  const updatePromise = runStartupAutoUpdateIfEnabled()
    .then(() => "done")
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error ?? "unknown");
      console.warn(`[updater] startup update gate failed: ${message}`);
      logStartupDiagnostic("updater:startup-gate-failed", {
        message,
      }, "warn");
      return "failed";
    });

  const outcome = await Promise.race([updatePromise, timeoutPromise]);
  if (timeoutHandle != null) {
    clearTimeout(timeoutHandle);
    timeoutHandle = null;
  }

  if (outcome === "timeout") {
    startupAutoUpdateGateExpired = true;
    startupUpdaterBlockTimedOut = true;
    updaterAutoInstallInFlight = false;
    updaterInstallGuardActive = false;
    console.warn(`[updater] startup update check timed out after ${STARTUP_AUTO_UPDATE_BLOCK_TIMEOUT_MS}ms; continuing app launch.`);
    if (isStartupStatusPanelLifecycleActive()) {
      setStatusPanelPhase(STATUS_PANEL_PHASE.LOADING_SHELL, {
        title: "Carregando Messly",
        subtitle: "Abrindo aplicativo",
        showProgressBar: true,
        indeterminate: true,
      }, {
        force: true,
      });
    }
    restoreWindowsAfterUpdateFlow();
    logStartupDiagnostic("updater:startup-gate-timeout", {
      blockTimeoutMs: STARTUP_AUTO_UPDATE_BLOCK_TIMEOUT_MS,
      updaterStatus: getUpdaterStateStatus(appUpdater?.getState?.()),
    }, "warn");
    return;
  }

  logStartupDiagnostic("updater:startup-gate-finished", {
    outcome,
    updaterStatus: getUpdaterStateStatus(appUpdater?.getState?.()),
  });
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

function normalizeAccessToken(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getRendererShellOrigin() {
  if (app.isPackaged) {
    return getProductionRendererOrigin();
  }

  try {
    return new URL(process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL || DEV_SERVER_URL).origin;
  } catch {
    return null;
  }
}

function getProfileMediaProxyUrl() {
  return `${getConfiguredAppApiBaseUrl()}${PROFILE_MEDIA_PROXY_PATH}`;
}

function classifyProfileMediaUploadFailure(statusCode, code, message) {
  const normalizedCode = typeof code === "string" ? code.trim().toUpperCase() : "";
  const normalizedMessage = typeof message === "string" ? message.trim().toLowerCase() : "";

  if (!statusCode) {
    return "network";
  }

  if (
    normalizedCode === "UNAUTHORIZED"
    || normalizedCode === "INVALID_TOKEN"
    || normalizedCode === "AUTH_REQUIRED"
    || statusCode === 401
    || statusCode === 403
  ) {
    return "auth";
  }

  if (
    normalizedCode === "FILE_TOO_LARGE"
    || normalizedCode === "UNSUPPORTED_TYPE"
    || normalizedCode === "DIMENSIONS_TOO_SMALL"
    || normalizedCode === "DIMENSIONS_TOO_LARGE"
    || normalizedCode === "INVALID_IMAGE"
    || normalizedCode === "GIF_TOO_MANY_FRAMES"
    || normalizedCode === "INVALID_MEDIA_KIND"
    || statusCode === 400
    || statusCode === 413
    || normalizedMessage.includes("invalid")
  ) {
    return "validation";
  }

  if (normalizedCode === "PROFILE_PERSISTENCE_FAILED" || normalizedCode === "PROFILE_NOT_FOUND") {
    return "persistence";
  }

  if (normalizedCode.includes("STORAGE") || normalizedMessage.includes("storage") || normalizedMessage.includes("bucket")) {
    return "storage";
  }

  if (statusCode >= 500) {
    return "server";
  }

  return "http";
}

function logProfileMediaUploadEvent(
  event,
  details = {},
  level = "info",
) {
  const payload = {
    environment: "main-process",
    origin: getRendererShellOrigin(),
    webOrigin: getConfiguredWebOrigin(),
    apiBaseUrl: getConfiguredAppApiBaseUrl(),
    mediaProxyUrl: getProfileMediaProxyUrl(),
    ...details,
  };

  try {
    const line = `[profile-media:main] ${event}`;
    if (level === "error") {
      console.error(line, payload);
    } else if (level === "warn") {
      console.warn(line, payload);
    } else {
      console.info(line, payload);
    }
  } catch {}
}

function isInvalidManagedMediaApiBaseUrl(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return true;
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return true;
    }

    const hostname = parsed.hostname.trim().toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return (hostname === "messly.site" || hostname === "www.messly.site") && (!pathname || !pathname.startsWith("/api"));
  } catch {
    return true;
  }
}

function shouldRetryManagedMediaUploadProxy(statusCode, attempt, maxAttempts) {
  if (attempt >= maxAttempts) {
    return false;
  }

  return !statusCode || statusCode >= 500 || statusCode === 429 || statusCode === 408;
}

async function waitForManagedMediaRetry(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function parseJsonSafe(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toStructuredProfileMediaProxyError(statusCode, payload, responseText) {
  const record = payload && typeof payload === "object" ? payload : null;
  const nestedError = record && record.error && typeof record.error === "object" ? record.error : null;
  const code = String((nestedError && nestedError.code) || (record && record.code) || "").trim().toUpperCase();
  const message = String((nestedError && nestedError.message) || (record && record.message) || "").trim();
  const details =
    nestedError && nestedError.details && typeof nestedError.details === "object" && !Array.isArray(nestedError.details)
      ? nestedError.details
      : {};

  if (
    code === "FILE_TOO_LARGE"
    || code === "UNSUPPORTED_TYPE"
    || code === "DIMENSIONS_TOO_SMALL"
    || code === "DIMENSIONS_TOO_LARGE"
    || code === "INVALID_IMAGE"
    || code === "GIF_TOO_MANY_FRAMES"
  ) {
    return createMediaUploadError(code, details);
  }

  const fallbackMessage = responseText ? responseText.replace(/\s+/g, " ").trim().slice(0, 260) : "";
  const finalMessage =
    message
      ? `Profile media proxy upload failed (${statusCode}): ${message}`
      : fallbackMessage
        ? `Profile media proxy upload failed (${statusCode}): ${fallbackMessage}`
        : `Profile media proxy upload failed (${statusCode}).`;

  const error = new Error(finalMessage);
  error.statusCode = statusCode;
  error.code = code || `HTTP_${statusCode}`;
  error.details = details;
  error.failureType = classifyProfileMediaUploadFailure(statusCode, code, finalMessage);
  return error;
}

function toProfileMediaProxySuccess(payload) {
  const record = payload && typeof payload === "object" ? payload : null;
  if (!record) {
    throw new Error("Profile media proxy returned an invalid JSON payload.");
  }

  const key = String(record.key ?? "").trim();
  const hash = String(record.hash ?? "").trim().toLowerCase();
  const size = Number(record.size ?? NaN);
  const strategy = String(record.strategy ?? "server-proxy").trim() || "server-proxy";
  const versionedUrl = String(record.versionedUrl ?? record.cdnUrl ?? "").trim() || null;
  const persistedProfile =
    record.persistedProfile && typeof record.persistedProfile === "object" && !Array.isArray(record.persistedProfile)
      ? record.persistedProfile
      : null;

  if (!key || !hash || !Number.isFinite(size)) {
    throw new Error("Profile media proxy returned an incomplete upload payload.");
  }

  return {
    key,
    hash,
    size,
    strategy,
    versionedUrl,
    persistedProfile,
  };
}

async function uploadProfileMediaViaOfficialProxy({ kind, userId, contentType, bytes, accessToken, fileName }) {
  const apiBaseUrl = getConfiguredAppApiBaseUrl();
  if (isInvalidManagedMediaApiBaseUrl(apiBaseUrl)) {
    throw new Error("Invalid app API base URL for profile media proxy.");
  }

  if (!accessToken) {
    const authError = new Error("Sessao invalida ou expirada para envio de imagem.");
    authError.statusCode = 401;
    authError.code = "UNAUTHORIZED";
    authError.failureType = "auth";
    throw authError;
  }

  const endpointUrl = new URL(`${apiBaseUrl}${PROFILE_MEDIA_PROXY_PATH}`);
  endpointUrl.searchParams.set("kind", kind);
  if (typeof fileName === "string" && fileName.trim()) {
    endpointUrl.searchParams.set("fileName", fileName.trim());
  }
  const endpoint = endpointUrl.toString();
  const maxAttempts = 2;

  logProfileMediaUploadEvent("upload endpoint", {
    transport: "official-profile-proxy",
    kind,
    userId,
    endpoint,
    method: "POST",
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      logProfileMediaUploadEvent("upload start", {
        transport: "official-profile-proxy",
        kind,
        userId,
        attempt,
        endpoint,
        contentType: contentType || "application/octet-stream",
        size: Buffer.byteLength(bytes),
      });

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": contentType || "application/octet-stream",
        },
        body: bytes,
      });

      const responseText = await response.text().catch(() => "");
      const responsePayload = parseJsonSafe(responseText);

      if (response.ok) {
        const uploaded = toProfileMediaProxySuccess(responsePayload);
        logProfileMediaUploadEvent("upload response", {
          transport: "official-profile-proxy",
          kind,
          userId,
          attempt,
          endpoint,
          status: response.status,
          key: uploaded.key,
          size: uploaded.size,
          strategy: uploaded.strategy,
        });
        if (uploaded.persistedProfile) {
          logProfileMediaUploadEvent("upload persisted profile", {
            transport: "official-profile-proxy",
            kind,
            userId,
            persistedProfile: uploaded.persistedProfile,
          });
        }
        logProfileMediaUploadEvent("upload final strategy", {
          transport: "official-profile-proxy",
          kind,
          userId,
          strategy: uploaded.strategy,
        });
        return uploaded;
      }

      const responseDetail = responseText.replace(/\s+/g, " ").trim().slice(0, 260);
      const errorCode =
        responsePayload && typeof responsePayload === "object" && responsePayload.error && typeof responsePayload.error === "object"
          ? String(responsePayload.error.code ?? "").trim().toUpperCase()
          : "";
      const failureType = classifyProfileMediaUploadFailure(response.status, errorCode, responseDetail);
      logProfileMediaUploadEvent("upload error", {
        transport: "official-profile-proxy",
        kind,
        userId,
        attempt,
        endpoint,
        status: response.status,
        code: errorCode || null,
        failureType,
        response: responseDetail || null,
      }, "error");

      if (shouldRetryManagedMediaUploadProxy(response.status, attempt, maxAttempts)) {
        await waitForManagedMediaRetry(450 * attempt);
        continue;
      }

      throw toStructuredProfileMediaProxyError(response.status, responsePayload, responseText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "unknown_error");
      const statusCode =
        error && typeof error === "object" && "statusCode" in error
          ? Number(error.statusCode ?? NaN)
          : null;
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code ?? "").trim().toUpperCase()
          : null;
      const failureType =
        error && typeof error === "object" && "failureType" in error
          ? String(error.failureType ?? "").trim() || null
          : classifyProfileMediaUploadFailure(Number.isFinite(statusCode ?? NaN) ? statusCode : null, code, message);
      logProfileMediaUploadEvent("upload error", {
        transport: "official-profile-proxy",
        kind,
        userId,
        attempt,
        endpoint,
        message,
        statusCode: Number.isFinite(statusCode ?? NaN) ? statusCode : null,
        code,
        failureType,
      }, "error");

      if (shouldRetryManagedMediaUploadProxy(Number.isFinite(statusCode ?? NaN) ? statusCode : null, attempt, maxAttempts)) {
        await waitForManagedMediaRetry(450 * attempt);
        continue;
      }

      throw error;
    }
  }
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

  const accessToken = normalizeAccessToken(payload?.accessToken);

  try {
    logProfileMediaUploadEvent("upload start", {
      transport: "electron-ipc",
      kind,
      userId,
      hasAccessToken: Boolean(accessToken),
      fileName: typeof payload?.fileName === "string" ? payload.fileName.trim() || null : null,
      mimeType: typeof payload?.mimeType === "string" ? payload.mimeType.trim() || null : null,
    });
    const binaryPayload = normalizeBinaryPayload(payload?.bytes);
    const uploaded = await uploadProfileMediaViaOfficialProxy({
      kind,
      userId,
      contentType:
        typeof payload?.mimeType === "string" && payload.mimeType.trim()
          ? payload.mimeType.trim()
          : "application/octet-stream",
      bytes: binaryPayload,
      accessToken,
      fileName: typeof payload?.fileName === "string" ? payload.fileName.trim() : "",
    });

    return {
      key: uploaded.key,
      hash: uploaded.hash,
      size: uploaded.size,
      versionedUrl: uploaded.versionedUrl,
      strategy: uploaded.strategy,
      persistedProfile: uploaded.persistedProfile,
    };
  } catch (error) {
    if (isMediaUploadError(error)) {
      throw error;
    }

    if (error instanceof Error && error.message === "Invalid binary payload.") {
      throw createMediaUploadError("INVALID_IMAGE", {});
    }

    logProfileMediaUploadEvent("upload error", {
      transport: "electron-ipc",
      kind,
      userId,
      message: error instanceof Error ? error.message : String(error ?? "unknown_error"),
      statusCode:
        error && typeof error === "object" && "statusCode" in error
          ? Number(error.statusCode ?? NaN)
          : null,
      code:
        error && typeof error === "object" && "code" in error
          ? String(error.code ?? "").trim().toUpperCase() || null
          : null,
      failureType:
        error && typeof error === "object" && "failureType" in error
          ? String(error.failureType ?? "").trim() || null
          : null,
    }, "error");
    throw error;
  }
}

async function uploadAttachmentHandler(_event, payload) {
  const safeKey = sanitizeMediaKey(payload?.key);
  if (!safeKey || (!safeKey.startsWith("attachments/") && !safeKey.startsWith("messages/"))) {
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

async function logRendererDiagnosticsHandler(_event, payload) {
  const source = String(payload?.source ?? "renderer").trim() || "renderer";
  const event = String(payload?.event ?? "unknown").trim() || "unknown";
  const levelRaw = String(payload?.level ?? "info").trim().toLowerCase();
  const level = ["debug", "info", "warn", "error"].includes(levelRaw) ? levelRaw : "info";
  const details =
    payload?.details && typeof payload.details === "object" && !Array.isArray(payload.details)
      ? payload.details
      : {};

  const line = `[diagnostics:${source}] ${event}`;
  if (level === "debug") {
    console.debug(line, details);
  } else if (level === "warn") {
    console.warn(line, details);
  } else if (level === "error") {
    console.error(line, details);
  } else {
    console.info(line, details);
  }
  logStartupDiagnostic(`renderer-diagnostic:${source}:${event}`, details, level);

  return {
    ok: true,
    recordedAt: new Date().toISOString(),
  };
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
  ipcMain.removeHandler("diagnostics:log");
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
  ipcMain.removeHandler("notifications:notify-call");
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
    setStatusPanelPhase(STATUS_PANEL_PHASE.CHECKING, {}, { force: true });
    return appUpdater.checkForUpdates();
  });
  ipcMain.handle("updater:download", async () => {
    if (!appUpdater?.downloadUpdate) {
      throw new Error("Updater indisponível.");
    }
    setStatusPanelPhase(STATUS_PANEL_PHASE.DOWNLOADING, {
      progressPercent: 4,
      showProgress: true,
    }, {
      force: true,
    });
    return appUpdater.downloadUpdate();
  });
  ipcMain.handle("updater:install", async () => {
    if (!appUpdater?.installUpdate) {
      throw new Error("Updater indisponível.");
    }
    setStatusPanelPhase(STATUS_PANEL_PHASE.INSTALLING, {
      indeterminate: true,
    }, {
      force: true,
    });
    hideWindowsForUpdateFlow();
    updaterAutoInstallInFlight = true;
    updaterInstallGuardActive = true;
    try {
      setStatusPanelPhase(STATUS_PANEL_PHASE.RELAUNCHING, {
        title: "Atualização concluída",
        subtitle: "Reiniciando aplicativo",
        indeterminate: true,
      }, {
        force: true,
      });
      return await appUpdater.installUpdate();
    } catch (error) {
      updaterAutoInstallInFlight = false;
      updaterInstallGuardActive = false;
      setStatusPanelPhase(STATUS_PANEL_PHASE.FAILED, {
        detail: "Não foi possível concluir a atualização.",
      }, {
        force: true,
      });
      scheduleStatusPanelAutoHide(1800, STATUS_PANEL_PHASE.FAILED);
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
    return getStoredRefreshTokenFromSecureStorage();
  });
  ipcMain.handle("auth:refresh-token:set", async (_event, token) => {
    return setStoredRefreshTokenInSecureStorage(token);
  });
  ipcMain.handle("auth:refresh-token:remove", async () => {
    return clearStoredRefreshTokenInSecureStorage();
  });
  ipcMain.handle("diagnostics:log", logRendererDiagnosticsHandler);
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
  ipcMain.handle("notifications:notify-call", notifyCallHandler);
  ipcMain.on("notifications:renderer-ready", notificationsRendererReadyHandler);
  ipcMain.on("app:renderer-first-frame-ready", handleRendererFirstFrameReady);
}

function createMainWindow() {
  markMainStartupPerf("main:create-window:requested");
  logStartupDiagnostic("window:create-requested", {
    isAppQuitting,
    startupUpdaterBlockTimedOut,
    updaterStatus: getUpdaterStateStatus(appUpdater?.getState?.()),
  });
  const existingWindow = getMainWindow();
  if (existingWindow) {
    markMainStartupPerf("main:create-window:reuse-existing");
    logStartupDiagnostic("window:create-reused-existing", {
      visible: existingWindow.isVisible(),
      minimized: existingWindow.isMinimized(),
    }, "debug");
    notificationNavigationCoordinator.registerWindow(existingWindow);
    if (!mainWindowWaitingForFirstFrame && !existingWindow.isVisible()) {
      existingWindow.show();
    }
    return existingWindow;
  }

  loadWindowsBehaviorSettings();
  const startMinimized = shouldStartMinimizedThisLaunch();
  const shouldUseStartupStatusPanel = isStartupStatusPanelLifecycleActive() && !startMinimized;
  mainWindowWaitingForFirstFrame = !startMinimized;
  mainWindowFirstFrameReady = false;
  markMainStartupPerf("main:create-window:new", {
    startMinimized,
  });
  measureMainStartupPerf("main_entry_to_create_window", "main:entry", "main:create-window:new", {
    startMinimized,
  });
  logStartupDiagnostic("window:create-new", {
    startMinimized,
    shouldUseStartupStatusPanel,
  });

  if (shouldUseStartupStatusPanel) {
    setStatusPanelPhase(STATUS_PANEL_PHASE.LAUNCHING, {
      progressPercent: 12,
      indeterminate: true,
    }, {
      force: true,
    });
  }

  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 980,
    minHeight: 640,
    show: false,
    skipTaskbar: false,
    autoHideMenuBar: true,
    transparent: false,
    backgroundColor: APP_STARTUP_BACKGROUND_COLOR,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#00000000",
      symbolColor: "#f2f2f2",
      height: 38,
    },
    icon: mainWindowIconImageCache || MAIN_WINDOW_ICON_PATH || process.execPath,
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
    if (updaterInstallGuardActive && !isAppQuitting) {
      event.preventDefault();
      if (isStartupStatusPanelLifecycleActive()) {
        setStatusPanelPhase(
          STATUS_PANEL_PHASE.INSTALLING,
          {
            title: "Instalando atualização",
            subtitle: "Não feche o aplicativo",
            detail: "A instalação precisa ser concluída para reiniciar.",
            indeterminate: true,
          },
          {
            force: true,
          },
        );
      }
      return;
    }

    const shouldMinimizeToTray = loadWindowsBehaviorSettings().closeToTray;
    if (!shouldMinimizeToTray || isAppQuitting) {
      return;
    }
    event.preventDefault();
    void createAppTray();
    mainWindow.hide();
  });

  mainWindow.once("ready-to-show", () => {
    markMainStartupPerf("main:window-ready-to-show", {
      startMinimized,
    });
    logStartupDiagnostic("window:ready-to-show", {
      startMinimized,
      mainWindowFirstFrameReady,
    });
    measureMainStartupPerf("main_entry_to_window_ready_to_show", "main:entry", "main:window-ready-to-show", {
      startMinimized,
    });
    if (mainWindow.isDestroyed()) {
      return;
    }
    if (!mainWindowFirstFrameReady && shouldUseStartupStatusPanel) {
      setStatusPanelPhase(STATUS_PANEL_PHASE.LOADING_SHELL, {
        progressPercent: 72,
        indeterminate: true,
      });
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
    if (rendererRetryTimer != null) {
      clearTimeout(rendererRetryTimer);
      rendererRetryTimer = null;
    }
    clearMainWindowFirstFrameFallbackTimer();
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

  let rendererUrl = "";
  let rendererLoadAttemptId = 0;
  let rendererFailureHandledForActiveAttempt = false;
  let rendererLoadFailureDisplayed = false;
  let rendererRetryCount = 0;
  let rendererRetryTimer = null;
  const bundledRendererFallbackUrl = app.isPackaged ? resolveBundledRendererStartupUrl() : null;
  let rendererBundledFallbackAttempted = false;

  const clearRendererRetryTimer = () => {
    if (rendererRetryTimer != null) {
      clearTimeout(rendererRetryTimer);
      rendererRetryTimer = null;
    }
  };

  const extractRendererErrorCode = (rawCode, description) => {
    const numericCode = Number(rawCode);
    if (Number.isFinite(numericCode)) {
      return numericCode;
    }
    const normalizedDescription = String(description ?? "").trim();
    if (!normalizedDescription) {
      return null;
    }
    const match = normalizedDescription.match(/\((-?\d+)\)/);
    if (!match) {
      return null;
    }
    const parsedCode = Number.parseInt(match[1], 10);
    return Number.isFinite(parsedCode) ? parsedCode : null;
  };

  const isRendererAbortFailure = (errorCode, errorDescription) => {
    if (Number(errorCode) === RENDERER_BOOTSTRAP_ABORT_CODE) {
      return true;
    }
    return String(errorDescription ?? "").toUpperCase().includes("ERR_ABORTED");
  };

  const isRetriableRendererBootstrapFailure = (errorCode, errorDescription) => {
    if (Number.isFinite(Number(errorCode)) && RENDERER_BOOTSTRAP_RETRIABLE_ERROR_CODES.has(Number(errorCode))) {
      return true;
    }
    const normalizedDescription = String(errorDescription ?? "").toUpperCase();
    if (!normalizedDescription) {
      return false;
    }
    return (
      normalizedDescription.includes("ERR_NAME_NOT_RESOLVED")
      || normalizedDescription.includes("ERR_NAME_RESOLUTION_FAILED")
      || normalizedDescription.includes("ERR_INTERNET_DISCONNECTED")
      || normalizedDescription.includes("ERR_CONNECTION_TIMED_OUT")
      || normalizedDescription.includes("ERR_NETWORK_CHANGED")
    );
  };

  const scheduleRendererBootstrapRetry = (context = {}) => {
    if (mainWindowFirstFrameReady || rendererLoadFailureDisplayed) {
      return false;
    }
    if (rendererRetryCount >= RENDERER_BOOTSTRAP_MAX_RETRIES) {
      return false;
    }

    rendererRetryCount += 1;
    const retryDelayMs =
      RENDERER_BOOTSTRAP_RETRY_DELAYS_MS[rendererRetryCount - 1]
      ?? RENDERER_BOOTSTRAP_RETRY_DELAYS_MS[RENDERER_BOOTSTRAP_RETRY_DELAYS_MS.length - 1]
      ?? 1800;
    const errorCode = extractRendererErrorCode(context.errorCode, context.errorDescription);
    const errorDescription = String(context.errorDescription ?? "").trim();

    console.warn(`[electron] renderer bootstrap retry scheduled (${rendererRetryCount}/${RENDERER_BOOTSTRAP_MAX_RETRIES})`, {
      reason: String(context.reason ?? "").trim() || null,
      errorCode,
      errorDescription: errorDescription || null,
      retryDelayMs,
      validatedURL: String(context.validatedURL ?? "").trim() || null,
    });
    logStartupDiagnostic("renderer:retry-scheduled", {
      attempt: rendererRetryCount,
      maxAttempts: RENDERER_BOOTSTRAP_MAX_RETRIES,
      reason: String(context.reason ?? "").trim() || null,
      errorCode,
      errorDescription: errorDescription || null,
      retryDelayMs,
      validatedURL: String(context.validatedURL ?? "").trim() || null,
    }, "warn");

    if (shouldUseStartupStatusPanel) {
      setStatusPanelPhase(STATUS_PANEL_PHASE.RETRYING, {
        title: "Reconectando ao Messly",
        subtitle: `Tentativa ${Math.min(rendererRetryCount + 1, RENDERER_BOOTSTRAP_MAX_RETRIES + 1)} de ${RENDERER_BOOTSTRAP_MAX_RETRIES + 1}`,
        showProgressBar: true,
        showProgress: false,
        indeterminate: true,
        progressPercent: 34,
      }, {
        force: true,
      });
    }

    clearRendererRetryTimer();
    rendererRetryTimer = setTimeout(() => {
      rendererRetryTimer = null;
      if (mainWindow.isDestroyed() || mainWindowFirstFrameReady || rendererLoadFailureDisplayed) {
        return;
      }
      void loadMainRendererUrl("retry");
    }, retryDelayMs);
    return true;
  };

  const showFatalRendererBootstrapFailure = (context = {}) => {
    if (rendererLoadFailureDisplayed || mainWindow.isDestroyed()) {
      return;
    }
    rendererLoadFailureDisplayed = true;
    clearRendererRetryTimer();
    showMainWindowRendererLoadFailure(mainWindow, {
      rendererUrl: rendererUrl || (app.isPackaged ? getExpectedProductionRendererUrl() : DEV_SERVER_URL),
      validatedURL: String(context.validatedURL ?? "").trim(),
      errorCode: extractRendererErrorCode(context.errorCode, context.errorDescription),
      errorDescription: String(context.errorDescription ?? "").trim(),
      reason: String(context.reason ?? "Falha ao iniciar o carregamento do renderer.").trim(),
      details: String(context.details ?? "").trim(),
    });
  };

  const handleRendererBootstrapFailure = (context = {}) => {
    if (mainWindow.isDestroyed() || mainWindowFirstFrameReady || rendererLoadFailureDisplayed) {
      return;
    }

    const errorDescription = String(context.errorDescription ?? "").trim();
    const errorCode = extractRendererErrorCode(context.errorCode, errorDescription);
    if (isRendererAbortFailure(errorCode, errorDescription)) {
      return;
    }

    if (isRetriableRendererBootstrapFailure(errorCode, errorDescription)) {
      const didScheduleRetry = scheduleRendererBootstrapRetry({
        ...context,
        errorCode,
        errorDescription,
      });
      if (didScheduleRetry) {
        return;
      }
    }

    const shouldTryBundledFallback =
      app.isPackaged
      && !rendererBundledFallbackAttempted
      && typeof bundledRendererFallbackUrl === "string"
      && bundledRendererFallbackUrl.length > 0
      && bundledRendererFallbackUrl !== rendererUrl;

    if (shouldTryBundledFallback) {
      rendererBundledFallbackAttempted = true;
      const failureDetails =
        String(context.details ?? "").trim()
        || errorDescription
        || (errorCode !== null ? `error code ${errorCode}` : "unknown renderer failure");
      logStartupDiagnostic("renderer:fallback-to-bundled", {
        previousRendererUrl: rendererUrl || null,
        fallbackRendererUrl: bundledRendererFallbackUrl,
        errorCode,
        errorDescription: errorDescription || null,
        reason: String(context.reason ?? "").trim() || null,
        details: failureDetails,
      }, "warn");
      if (shouldUseStartupStatusPanel) {
        setStatusPanelPhase(STATUS_PANEL_PHASE.LOADING_SHELL, {
          title: "Carregando Messly",
          subtitle: "Usando interface local",
          detail: "Conexao com o servidor oscilando. Continuando com modo local.",
          showProgressBar: true,
          showProgress: false,
          indeterminate: true,
          progressPercent: 64,
        }, {
          force: true,
        });
      }
      rendererRetryCount = 0;
      rendererUrl = bundledRendererFallbackUrl;
      void loadMainRendererUrl("bundled-fallback");
      return;
    }

    const failureDetails =
      String(context.details ?? "").trim()
      || errorDescription
      || (errorCode !== null ? `error code ${errorCode}` : "");
    showFatalRendererBootstrapFailure({
      ...context,
      errorCode,
      errorDescription,
      details: failureDetails,
    });
  };

  async function loadMainRendererUrl(source = "initial") {
    if (mainWindow.isDestroyed() || rendererLoadFailureDisplayed) {
      return;
    }

    clearRendererRetryTimer();
    rendererLoadAttemptId += 1;
    const currentAttemptId = rendererLoadAttemptId;
    rendererFailureHandledForActiveAttempt = false;
    const normalizedSource = String(source ?? "initial").trim() || "initial";
    scheduleMainWindowFirstFrameFallback(mainWindow, startMinimized);

    if (shouldUseStartupStatusPanel && (normalizedSource === "retry" || normalizedSource === "bundled-fallback")) {
      setStatusPanelPhase(STATUS_PANEL_PHASE.LOADING_SHELL, {
        title: "Carregando Messly",
        subtitle: normalizedSource === "bundled-fallback" ? "Aplicando fallback local" : "Reconectando interface",
        showProgressBar: true,
        showProgress: false,
        indeterminate: true,
        progressPercent: 64,
      }, {
        force: true,
      });
    }

    logStartupDiagnostic("renderer:load-attempt", {
      source: normalizedSource,
      attemptId: currentAttemptId,
      rendererUrl,
      startMinimized,
      bundledFallbackAvailable: Boolean(bundledRendererFallbackUrl),
      bundledFallbackAttempted: rendererBundledFallbackAttempted,
    });

    try {
      await mainWindow.loadURL(rendererUrl);
      logStartupDiagnostic("renderer:load-dispatched", {
        source: normalizedSource,
        attemptId: currentAttemptId,
        rendererUrl,
      });
    } catch (error) {
      if (mainWindow.isDestroyed() || mainWindowFirstFrameReady || rendererLoadFailureDisplayed) {
        return;
      }
      if (currentAttemptId !== rendererLoadAttemptId) {
        return;
      }
      if (rendererFailureHandledForActiveAttempt) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error ?? "unknown");
      const parsedCode = extractRendererErrorCode(null, message);
      if (isRendererAbortFailure(parsedCode, message)) {
        return;
      }
      logStartupDiagnostic("renderer:load-throw", {
        source: normalizedSource,
        attemptId: currentAttemptId,
        rendererUrl,
        errorCode: parsedCode,
        errorDescription: message,
      }, "warn");
      rendererFailureHandledForActiveAttempt = true;
      handleRendererBootstrapFailure({
        errorCode: parsedCode,
        errorDescription: message,
        reason: "Falha ao iniciar o carregamento do renderer.",
        details: message,
      });
    }
  }

  const handleRendererDidFailLoad = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) {
      return;
    }
    if (rendererLoadFailureDisplayed || mainWindowFirstFrameReady) {
      return;
    }
    const normalizedErrorDescription = String(errorDescription ?? "").trim();
    const normalizedErrorCode = extractRendererErrorCode(errorCode, normalizedErrorDescription);
    if (isRendererAbortFailure(normalizedErrorCode, normalizedErrorDescription)) {
      return;
    }
    const validatedUrlValue = String(validatedURL ?? "").trim();
    if (validatedUrlValue.startsWith("data:text/html")) {
      return;
    }
    logStartupDiagnostic("renderer:did-fail-load", {
      validatedURL: validatedUrlValue || null,
      errorCode: normalizedErrorCode,
      errorDescription: normalizedErrorDescription || null,
      rendererUrl,
    }, "warn");
    rendererFailureHandledForActiveAttempt = true;
    handleRendererBootstrapFailure({
      validatedURL: validatedUrlValue,
      errorCode: normalizedErrorCode,
      errorDescription: normalizedErrorDescription,
      reason: "Erro de navegação ao carregar o renderer.",
    });
  };
  const handleRendererGoneBeforeReady = (_event, details) => {
    if (mainWindowFirstFrameReady || rendererLoadFailureDisplayed) {
      return;
    }
    logStartupDiagnostic("renderer:process-gone-before-ready", {
      reason: String(details?.reason ?? "").trim() || "render-process-gone",
      exitCode: Number(details?.exitCode ?? 0) || null,
      rendererUrl,
    }, "warn");
    rendererFailureHandledForActiveAttempt = true;
    handleRendererBootstrapFailure({
      reason: "O processo de renderização encerrou antes da interface ficar pronta.",
      errorDescription: String(details?.reason ?? "").trim() || "render-process-gone",
    });
  };
  mainWindowWebContents.on("did-fail-load", handleRendererDidFailLoad);
  mainWindowWebContents.on("render-process-gone", handleRendererGoneBeforeReady);

  try {
    rendererUrl = resolveRendererStartupUrl();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "unknown");
    console.error(`[electron] renderer bootstrap aborted: ${message}`);
    logStartupDiagnostic("renderer:bootstrap-aborted", {
      message,
    }, "error");
    throw error;
  }

  if (app.isPackaged) {
    if (bundledRendererFallbackUrl) {
      logStartupDiagnostic("renderer:bundled-fallback-ready", {
        bundledRendererFallbackUrl,
      });
    } else {
      logStartupDiagnostic("renderer:bundled-fallback-missing", {
        candidates: resolveBundledRendererFilePathCandidates(),
      }, "warn");
    }
  }

  markMainStartupPerf("main:window-load-started", {
    mode: app.isPackaged ? "production-url" : "dev-url",
    rendererUrl,
  });
  void loadMainRendererUrl("initial");
  return mainWindow;
}

function isUpdaterBlockingMainWindowCreation() {
  if (!BLOCK_MAIN_WINDOW_ON_STARTUP_UPDATE) {
    return false;
  }
  if (!app.isPackaged || !appUpdater?.getState) {
    return false;
  }
  if (startupUpdaterBlockTimedOut) {
    return false;
  }
  const status = String(appUpdater.getState()?.status ?? "").trim().toLowerCase();
  return (
    status === "checking" ||
    status === "downloading" ||
    status === "installing" ||
    status === "applying" ||
    status === "relaunching" ||
    status === "retrying"
  );
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
    if (!showMainWindow() && app.isReady() && !isUpdaterBlockingMainWindowCreation()) {
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
  if (!showMainWindow() && app.isReady() && !isUpdaterBlockingMainWindowCreation()) {
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
  logStartupDiagnostic("app:when-ready-entered", {
    appIsPackaged: app.isPackaged,
    blockMainWindowOnStartupUpdate: BLOCK_MAIN_WINDOW_ON_STARTUP_UPDATE,
    statusPanelEnabled: STATUS_PANEL_ENABLED,
  });
  markMainStartupPerf("main:when-ready");
  measureMainStartupPerf("main_entry_to_when_ready", "main:entry", "main:when-ready");
  if (typeof Menu.setApplicationMenu === "function") {
    Menu.setApplicationMenu(null);
  }
  if (process.platform === "win32" && typeof app.setAppUserModelId === "function") {
    try {
      // In development, forcing a production AUMID can make the taskbar icon
      // fall back to a generic placeholder. Keep the custom AUMID for packaged app only.
      if (app.isPackaged) {
        app.setAppUserModelId(getWindowsNotificationAppId());
      }
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

  const shouldStartMinimized = shouldStartMinimizedThisLaunch();
  startupStatusPanelLifecycleActive = false;
  clearStartupStatusPanelHardStopTimer();
  const shouldUseStartupStatusPanel =
    STATUS_PANEL_ENABLED &&
    app.isPackaged &&
    !shouldStartMinimized &&
    BLOCK_MAIN_WINDOW_ON_STARTUP_UPDATE;
  if (shouldUseStartupStatusPanel) {
    beginStartupStatusPanelLifecycle();
    setStatusPanelPhase(STATUS_PANEL_PHASE.CHECKING, {}, { force: true });
  }

  const initializeTray = async () => {
    markMainStartupPerf("main:tray-init:start");
    try {
      await createAppTray();
      refreshAppTrayMenu();
    } finally {
      markMainStartupPerf("main:tray-init:done");
      measureMainStartupPerf("main_tray_init_duration", "main:tray-init:start", "main:tray-init:done");
    }
  };

  const primeIconsAndApply = async () => {
    try {
      await prepareIconImages();
    } catch {}

    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed() && mainWindowIconImageCache && typeof mainWindow.setIcon === "function") {
      mainWindow.setIcon(mainWindowIconImageCache);
    }
    if (appTray && trayIconImageCache && !appTray.isDestroyed?.()) {
      appTray.setImage(trayIconImageCache);
    }
  };

  if (shouldStartMinimized) {
    await initializeTray();
  } else {
    void initializeTray();
  }
  void primeIconsAndApply();

  if (BLOCK_MAIN_WINDOW_ON_STARTUP_UPDATE) {
    try {
      logStartupDiagnostic("updater:startup-gate-awaiting", {});
      await runStartupAutoUpdateWithGuardTimeout();
    } catch {}
  }

  if (!isAppQuitting) {
    logStartupDiagnostic("window:create-main-requested", {
      isAppQuitting,
    });
    createMainWindow();
  }

  if (!BLOCK_MAIN_WINDOW_ON_STARTUP_UPDATE) {
    void runStartupAutoUpdateWithGuardTimeout().catch(() => {});
  }

  markMainStartupPerf("main:critical-startup-complete");
  logStartupDiagnostic("app:critical-startup-complete", {
    startupUpdaterBlockTimedOut,
    startupAutoUpdateGateExpired,
  });
  measureMainStartupPerf(
    "main_when_ready_to_critical_startup_complete",
    "main:when-ready",
    "main:critical-startup-complete",
  );

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
  }, 0);

  const autoCheckIntervalMs = Number.parseInt(String(process.env.AUTO_UPDATE_CHECK_INTERVAL_MS ?? ""), 10);
  setTimeout(() => {
    appUpdater.startAutoCheck(
      Number.isFinite(autoCheckIntervalMs) ? autoCheckIntervalMs : undefined,
      { skipInitialCheck: true },
    );
  }, 1500);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && !isUpdaterBlockingMainWindowCreation()) {
      createMainWindow();
    }
  });
});

app.on("before-quit", () => {
  logStartupDiagnostic("app:before-quit", {
    updaterStatus: getUpdaterStateStatus(appUpdater?.getState?.()),
    windowsOpen: BrowserWindow.getAllWindows().length,
  });
  isAppQuitting = true;
  updaterInstallGuardActive = false;
  updaterAutoInstallInFlight = false;
  startupStatusPanelLifecycleActive = false;
  clearStartupStatusPanelHardStopTimer();
  clearMainWindowFirstFrameFallbackTimer();
  if (updaterBroadcastThrottleTimer) {
    clearTimeout(updaterBroadcastThrottleTimer);
    updaterBroadcastThrottleTimer = null;
  }
  updaterBroadcastQueuedState = null;
  notificationManager?.dispose?.();
  notificationManager = null;
  notificationNavigationCoordinator.dispose();
  if (spotifyPresenceService) {
    spotifyPresenceService.dispose();
    spotifyPresenceService = null;
  }
  destroyEmbeddedDevToolsHost(getMainWindow());
  destroyAppTray();
  hideStatusPanel({ force: true });
});

app.on("window-all-closed", () => {
  appUpdater?.stopAutoCheck?.();
  if (process.platform !== "darwin" && !loadWindowsBehaviorSettings().closeToTray) {
    app.quit();
  }
});


