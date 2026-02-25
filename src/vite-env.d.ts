/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN: string;
  readonly VITE_FIREBASE_PROJECT_ID: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID: string;
  readonly VITE_FIREBASE_APP_ID: string;
  readonly VITE_FIREBASE_DATABASE_URL: string;
  readonly VITE_FIREBASE_PRESENCE_ENABLED?: string;
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_MEDIA_BUCKET?: string;
  readonly VITE_R2_BUCKET?: string;
  readonly VITE_MEDIA_PUBLIC_BASE_URL?: string;
  readonly VITE_R2_PUBLIC_BASE_URL?: string;
  readonly VITE_CHAT_KEEP_ORIGINAL_UPLOADS?: string;
  readonly VITE_CHAT_E2EE_ENABLED?: string;
  readonly VITE_WEBRTC_ICE_SERVERS_JSON?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface UploadProfileMediaPayload {
  kind: "avatar" | "banner";
  userId: string;
  bytes: ArrayBuffer | Uint8Array;
  mimeType?: string;
  fileName?: string;
}

interface UploadProfileMediaResult {
  key: string;
  hash: string;
  size: number;
}

interface UploadAttachmentPayload {
  key: string;
  bytes: ArrayBuffer | Uint8Array;
  contentType?: string;
}

interface UploadAttachmentResult {
  key: string;
  size: number;
}

interface GetSignedMediaUrlPayload {
  key: string;
  expiresSeconds?: number;
}

interface GetSignedMediaUrlResult {
  url: string;
  expiresAt: number;
}

interface OpenExternalUrlPayload {
  url: string;
}

interface OpenExternalUrlResult {
  opened: boolean;
}

interface SetWindowAttentionPayload {
  enabled: boolean;
}

interface SetWindowAttentionResult {
  enabled: boolean;
}

interface ScreenShareSource {
  id: string;
  name: string;
  displayId: string | null;
  thumbnail: string | null;
  appIcon: string | null;
}

interface ScreenShareSourceOptions {
  types?: Array<"screen" | "window">;
  thumbnailSize?: { width: number; height: number };
  fetchWindowIcons?: boolean;
}

type AppUpdaterStatus =
  | "idle"
  | "disabled"
  | "checking"
  | "available"
  | "unavailable"
  | "downloading"
  | "downloaded"
  | "error";

interface AppUpdaterState {
  enabled: boolean;
  status: AppUpdaterStatus;
  currentVersion: string;
  latestVersion: string | null;
  releaseName: string | null;
  publishedAt: string | null;
  releaseNotes: string | null;
  assetName: string | null;
  downloadedBytes: number;
  totalBytes: number;
  progressPercent: number;
  lastCheckedAt: string | null;
  errorMessage: string | null;
}

interface AppUpdaterDownloadResult {
  state: AppUpdaterState;
  filePath: string;
}

interface AppUpdaterInstallResult {
  launched: boolean;
}

interface WindowsBehaviorSettings {
  startMinimized: boolean;
  closeToTray: boolean;
  launchAtStartup: boolean;
}

interface WindowsBehaviorSettingsRestoreResult {
  restored: boolean;
}

interface ElectronApi {
  platform: string;
  arch?: string;
  getSignedMediaUrl?: (payload: GetSignedMediaUrlPayload) => Promise<GetSignedMediaUrlResult>;
  uploadProfileMedia?: (payload: UploadProfileMediaPayload) => Promise<UploadProfileMediaResult>;
  uploadAttachment?: (payload: UploadAttachmentPayload) => Promise<UploadAttachmentResult>;
  openExternalUrl?: (payload: OpenExternalUrlPayload) => Promise<OpenExternalUrlResult>;
  getScreenShareSources?: (options?: ScreenShareSourceOptions) => Promise<ScreenShareSource[]>;
  setWindowAttention?: (payload: SetWindowAttentionPayload) => Promise<SetWindowAttentionResult>;
  updaterGetState?: () => Promise<AppUpdaterState | null>;
  updaterCheck?: () => Promise<AppUpdaterState>;
  updaterDownload?: () => Promise<AppUpdaterDownloadResult>;
  updaterInstall?: () => Promise<AppUpdaterInstallResult>;
  getWindowsSettings?: () => Promise<WindowsBehaviorSettings>;
  updateWindowsSettings?: (payload: Partial<WindowsBehaviorSettings>) => Promise<WindowsBehaviorSettings>;
  restoreMainWindowFromTray?: () => Promise<WindowsBehaviorSettingsRestoreResult>;
  onUpdaterStateChanged?: (listener: (state: AppUpdaterState) => void) => () => void;
  versions: {
    chrome: string;
    electron: string;
    node: string;
  };
}

interface Window {
  electronAPI?: ElectronApi;
}
