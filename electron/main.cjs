const path = require("node:path");
const dotenv = require("dotenv");

dotenv.config({
  path: path.resolve(__dirname, "..", ".env"),
});

dotenv.config({
  path: path.resolve(__dirname, "..", ".env.local"),
  override: true,
});

const { app, BrowserWindow, desktopCapturer, ipcMain, Menu, shell } = require("electron");
const { GetObjectCommand, PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { backendEnv } = require("./config/env.cjs");
const { processAvatarUpload } = require("./media/avatarUpload.cjs");
const { processBannerUpload } = require("./media/bannerUpload.cjs");
const { createMediaUploadError, isMediaUploadError } = require("./media/uploadErrors.cjs");

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

let r2Client = null;

function getR2Client() {
  if (r2Client) {
    return r2Client;
  }

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
  return backendEnv.R2_BUCKET;
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
  ipcMain.handle("media:get-signed-url", getSignedMediaUrlHandler);
  ipcMain.handle("media:upload-profile", uploadProfileMediaHandler);
  ipcMain.handle("media:upload-attachment", uploadAttachmentHandler);
  ipcMain.handle("shell:open-external", openExternalUrlHandler);
  ipcMain.handle("screenshare:get-sources", getScreenShareSourcesHandler);
  ipcMain.handle("window:set-attention", setWindowAttentionHandler);
}

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1480,
    height: 800,
    minWidth: 980,
    minHeight: 640,
    autoHideMenuBar: true,
    backgroundColor: "#090a0c",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#00000000",
      symbolColor: "#f2f2f2",
      height: 38,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setAutoHideMenuBar(true);
  mainWindow.setMenuBarVisibility(false);
  if (typeof mainWindow.removeMenu === "function") {
    mainWindow.removeMenu();
  }
  if (typeof mainWindow.setMenu === "function") {
    mainWindow.setMenu(null);
  }

  mainWindow.webContents.setWindowOpenHandler((details) => {
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

  mainWindow.webContents.on("did-create-window", (childWindow, details) => {
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

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerIpcHandlers();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
