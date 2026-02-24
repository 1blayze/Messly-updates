const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

dotenv.config({
  path: path.resolve(__dirname, "..", ".env"),
});

dotenv.config({
  path: path.resolve(__dirname, "..", ".env.local"),
  override: true,
});

const { app, BrowserWindow, Tray, desktopCapturer, ipcMain, Menu, shell, nativeImage } = require("electron");
const { GetObjectCommand, PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { getBackendEnv } = require("./config/env.cjs");
const { processAvatarUpload } = require("./media/avatarUpload.cjs");
const { processBannerUpload } = require("./media/bannerUpload.cjs");
const { createMediaUploadError, isMediaUploadError } = require("./media/uploadErrors.cjs");
const { createElectronUpdaterAdapter } = require("./update/electronUpdaterAdapter.cjs");

const DEV_SERVER_URL = "http://localhost:5173";
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
const APP_ICONS_DIR = path.resolve(__dirname, "..", "src", "assets", "images", "img");
const WINDOWS_BEHAVIOR_SETTINGS_FILE = "windows-behavior-settings.json";
const DEFAULT_WINDOWS_BEHAVIOR_SETTINGS = Object.freeze({
  startMinimized: true,
  closeToTray: true,
  launchAtStartup: true,
});

function resolveAppIconPath(fileName) {
  const iconPath = path.join(APP_ICONS_DIR, fileName);
  return fs.existsSync(iconPath) ? iconPath : undefined;
}

const MAIN_WINDOW_ICON_PATH = resolveAppIconPath("messly-256.ico");
const CHILD_WINDOW_ICON_PATH = resolveAppIconPath("messly-64.ico") ?? MAIN_WINDOW_ICON_PATH;
const TRAY_ICON_PATH =
  resolveAppIconPath("messly-48.ico") ??
  resolveAppIconPath("messly-32.ico") ??
  resolveAppIconPath("messly-24.ico") ??
  resolveAppIconPath("messly-16.ico") ??
  CHILD_WINDOW_ICON_PATH ??
  MAIN_WINDOW_ICON_PATH;

let r2Client = null;
let backendEnvCache = null;
let appUpdater = null;
let mainWindowRef = null;
let appTray = null;
let isAppQuitting = false;
let windowsBehaviorSettings = null;

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

function buildTrayIconImage(iconPath) {
  const baseIcon = nativeImage.createFromPath(iconPath);
  if (baseIcon.isEmpty()) {
    return baseIcon;
  }

  if (process.platform !== "win32") {
    return baseIcon;
  }

  const trimmed = trimTransparentEdges(baseIcon);
  return trimmed.resize({ width: 24, height: 24, quality: "best" });
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

function getMainWindow() {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    return mainWindowRef;
  }
  mainWindowRef = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ?? null;
  return mainWindowRef;
}

function showMainWindow() {
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

function createAppTray() {
  if (appTray && !appTray.isDestroyed?.()) {
    return appTray;
  }
  const trayIconPath = TRAY_ICON_PATH;
  if (!trayIconPath) {
    return null;
  }

  const trayIcon = nativeImage.createFromPath(trayIconPath);
  const trayIconImage = buildTrayIconImage(trayIconPath);
  appTray = new Tray(trayIcon.isEmpty() ? trayIconPath : trayIconImage);
  appTray.setToolTip("Messly");
  appTray.on("click", () => {
    if (!showMainWindow()) {
      createMainWindow();
    }
  });

  const refreshTrayMenu = () => {
    if (!appTray) {
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
        label: "Verificar atualizacoes",
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
  };

  refreshTrayMenu();
  return appTray;
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

function createConfiguredAppUpdater() {
  const enableInDev = String(process.env.AUTO_UPDATE_ENABLE_IN_DEV ?? "").trim() === "true";
  if (!app.isPackaged && !enableInDev) {
    return createDisabledUpdater("Atualizador desativado no modo desenvolvimento.");
  }

  return createElectronUpdaterAdapter({
    app,
  });
}

function getR2Client() {
  if (r2Client) {
    return r2Client;
  }

  const backendEnv = getResolvedBackendEnv();

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

async function getSignedMediaUrlHandler(_event, payload) {
  const safeKey = sanitizeMediaKey(payload?.key);
  if (!safeKey) {
    throw new Error("Invalid media key.");
  }

  const expiresIn = normalizeSignedUrlTtl(payload?.expiresSeconds);
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
    const processedAsset = kind === "avatar" ? await processAvatarUpload(binaryPayload) : await processBannerUpload(binaryPayload);

    const prefix = PROFILE_MEDIA_PREFIX_BY_KIND[kind];
    const key = `${prefix}/${userId}/${processedAsset.hash}.${processedAsset.ext}`;

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
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Invalid external url.");
  }

  await shell.openExternal(url);
  return { opened: true };
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

function registerIpcHandlers() {
  ipcMain.removeHandler("media:get-signed-url");
  ipcMain.removeHandler("media:upload-profile");
  ipcMain.removeHandler("media:upload-attachment");
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
  ipcMain.handle("media:get-signed-url", getSignedMediaUrlHandler);
  ipcMain.handle("media:upload-profile", uploadProfileMediaHandler);
  ipcMain.handle("media:upload-attachment", uploadAttachmentHandler);
  ipcMain.handle("shell:open-external", openExternalUrlHandler);
  ipcMain.handle("screenshare:get-sources", getScreenShareSourcesHandler);
  ipcMain.handle("window:set-attention", setWindowAttentionHandler);
  ipcMain.handle("updater:get-state", async () => appUpdater?.getState?.() ?? null);
  ipcMain.handle("updater:check", async () => {
    if (!appUpdater?.checkForUpdates) {
      throw new Error("Updater indisponivel.");
    }
    return appUpdater.checkForUpdates();
  });
  ipcMain.handle("updater:download", async () => {
    if (!appUpdater?.downloadUpdate) {
      throw new Error("Updater indisponivel.");
    }
    return appUpdater.downloadUpdate();
  });
  ipcMain.handle("updater:install", async () => {
    if (!appUpdater?.installUpdate) {
      throw new Error("Updater indisponivel.");
    }
    return appUpdater.installUpdate();
  });
  ipcMain.handle("windows-settings:get", async () => ({ ...loadWindowsBehaviorSettings() }));
  ipcMain.handle("windows-settings:update", async (_event, payload) => {
    return setWindowsBehaviorSettings(payload ?? {});
  });
  ipcMain.handle("windows-settings:restore-window", async () => {
    return { restored: showMainWindow() };
  });
}

function createMainWindow() {
  loadWindowsBehaviorSettings();
  const mainWindow = new BrowserWindow({
    width: 1480,
    height: 800,
    minWidth: 980,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#090a0c",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#00000000",
      symbolColor: "#f2f2f2",
      height: 38,
    },
    icon: MAIN_WINDOW_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindowRef = mainWindow;

  mainWindow.setAutoHideMenuBar(true);
  mainWindow.setMenuBarVisibility(false);
  if (typeof mainWindow.removeMenu === "function") {
    mainWindow.removeMenu();
  }

  mainWindow.on("close", (event) => {
    const shouldMinimizeToTray = loadWindowsBehaviorSettings().closeToTray;
    if (!shouldMinimizeToTray || isAppQuitting) {
      return;
    }
    event.preventDefault();
    createAppTray();
    mainWindow.hide();
  });

  mainWindow.once("ready-to-show", () => {
    if (mainWindow.isDestroyed()) {
      return;
    }
    if (shouldStartMinimizedThisLaunch()) {
      mainWindow.show();
      mainWindow.minimize();
      return;
    }
    mainWindow.show();
  });
  let devToolsProgrammaticOpenEvents = 0;
  let isRedockingDevTools = false;

  const markProgrammaticDevToolsOpen = () => {
    devToolsProgrammaticOpenEvents += 1;
    setTimeout(() => {
      devToolsProgrammaticOpenEvents = Math.max(0, devToolsProgrammaticOpenEvents - 1);
    }, 250);
  };

  const openDockedDevTools = ({ toggleIfOpen = false } = {}) => {
    const webContents = mainWindow.webContents;
    if (!webContents || webContents.isDestroyed()) {
      return;
    }

    if (toggleIfOpen && webContents.isDevToolsOpened()) {
      webContents.closeDevTools();
      return;
    }

    if (isRedockingDevTools) {
      return;
    }
    isRedockingDevTools = true;

    const reopenDocked = () => {
      if (!webContents || webContents.isDestroyed()) {
        isRedockingDevTools = false;
        return;
      }
      markProgrammaticDevToolsOpen();
      webContents.openDevTools({ mode: "right", activate: true });
      setTimeout(() => {
        isRedockingDevTools = false;
      }, 50);
    };

    if (webContents.isDevToolsOpened()) {
      const handleClosed = () => {
        webContents.removeListener("devtools-closed", handleClosed);
        setImmediate(reopenDocked);
      };
      webContents.once("devtools-closed", handleClosed);
      webContents.closeDevTools();
      return;
    }

    reopenDocked();
  };

  const toggleDockedDevTools = (event, input) => {
    const key = String(input?.key ?? "").toLowerCase();
    const ctrlOrMeta = Boolean(input?.control || input?.meta);
    const isCtrlShiftI = ctrlOrMeta && Boolean(input?.shift) && key === "i";
    const isF12 = key === "f12";
    if (!isCtrlShiftI && !isF12) {
      return;
    }
    event.preventDefault();
    const webContents = mainWindow.webContents;
    if (!webContents || webContents.isDestroyed()) {
      return;
    }
    if (isF12) {
      openDockedDevTools({ toggleIfOpen: true });
      return;
    }
    openDockedDevTools();
  };
  const redockDevToolsOnOpen = () => {
    if (devToolsProgrammaticOpenEvents > 0 || isRedockingDevTools) {
      return;
    }
    openDockedDevTools();
  };
  const mainWindowWebContents = mainWindow.webContents;

  mainWindow.on("closed", () => {
    if (mainWindowRef === mainWindow) {
      mainWindowRef = null;
    }
    if (mainWindowWebContents && !mainWindowWebContents.isDestroyed()) {
      mainWindowWebContents.removeListener("before-input-event", toggleDockedDevTools);
      mainWindowWebContents.removeListener("devtools-opened", redockDevToolsOnOpen);
    }
  });
  if (typeof mainWindow.setMenu === "function") {
    mainWindow.setMenu(null);
  }

  mainWindowWebContents.on("before-input-event", toggleDockedDevTools);
  mainWindowWebContents.on("devtools-opened", redockDevToolsOnOpen);

  mainWindowWebContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith("http://") || details.url.startsWith("https://")) {
      shell.openExternal(details.url);
      return { action: "deny" };
    }

    const isCallPopout =
      details.frameName === CALL_POPOUT_FRAME_NAME ||
      details.url === `about:blank${CALL_POPOUT_URL_MARKER}` ||
      details.url.endsWith(CALL_POPOUT_URL_MARKER);

    if (isCallPopout) {
      return {
        action: "allow",
        outlivesOpener: true,
        overrideBrowserWindowOptions: {
          width: 900,
          height: 540,
          minWidth: 520,
          minHeight: 320,
          frame: true,
          show: false,
          autoHideMenuBar: true,
          backgroundColor: "#090a0c",
          title: "",
          titleBarStyle: "hidden",
          titleBarOverlay: {
            color: "#00000000",
            symbolColor: "#f2f2f2",
            height: 28,
          },
          icon: CHILD_WINDOW_ICON_PATH,
          webPreferences: {
            preload: path.join(__dirname, "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            autoplayPolicy: "no-user-gesture-required",
          },
        },
      };
    }

    return { action: "deny" };
  });

  mainWindowWebContents.on("did-create-window", (childWindow, details) => {
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
      if (CHILD_WINDOW_ICON_PATH && typeof childWindow.setIcon === "function") {
        childWindow.setIcon(CHILD_WINDOW_ICON_PATH);
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
    return;
  }

  mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!showMainWindow() && app.isReady()) {
      createMainWindow();
    }
  });
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) {
    return;
  }
  Menu.setApplicationMenu(null);
  loadWindowsBehaviorSettings();
  appUpdater = createConfiguredAppUpdater();
  appUpdater.setBroadcaster(broadcastUpdaterState);
  registerIpcHandlers();
  const autoCheckIntervalMs = Number.parseInt(String(process.env.AUTO_UPDATE_CHECK_INTERVAL_MS ?? ""), 10);
  appUpdater.startAutoCheck(Number.isFinite(autoCheckIntervalMs) ? autoCheckIntervalMs : undefined);
  createMainWindow();
  createAppTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("before-quit", () => {
  isAppQuitting = true;
});

app.on("window-all-closed", () => {
  appUpdater?.stopAutoCheck?.();
  if (process.platform !== "darwin" && !loadWindowsBehaviorSettings().closeToTray) {
    app.quit();
  }
});
