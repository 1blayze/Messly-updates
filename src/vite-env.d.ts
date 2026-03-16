/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SPOTIFY_CLIENT_ID?: string;
  readonly VITE_SPOTIFY_REDIRECT_URI?: string;
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_MESSLY_GATEWAY_URL?: string;
  readonly VITE_MESSLY_AUTH_API_URL?: string;
  readonly VITE_MESSLY_ALLOW_DIRECT_SUPABASE_AUTH_FALLBACK?: string;
  readonly VITE_TURNSTILE_SITE_KEY?: string;
  readonly VITE_MESSLY_API_URL?: string;
  readonly VITE_MESSLY_CDN_URL?: string;
  readonly VITE_MESSLY_ASSETS_URL?: string;
  readonly VITE_MESSLY_GATEWAY_CLIENT_VERSION?: string;
  readonly VITE_MEDIA_BUCKET?: string;
  readonly VITE_R2_BUCKET?: string;
  readonly VITE_MEDIA_PUBLIC_BASE_URL?: string;
  readonly VITE_R2_PUBLIC_BASE_URL?: string;
  readonly VITE_CHAT_KEEP_ORIGINAL_UPLOADS?: string;
  readonly VITE_CHAT_E2EE_ENABLED?: string;
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
  accessToken?: string;
}

interface UploadProfileMediaResult {
  key: string;
  hash: string;
  size: number;
  versionedUrl?: string | null;
  strategy?: string | null;
  persistedProfile?: {
    avatar_key?: string | null;
    avatar_hash?: string | null;
    avatar_url?: string | null;
    banner_key?: string | null;
    banner_hash?: string | null;
    banner_url?: string | null;
  } | null;
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

interface DownloadRemoteFilePayload {
  url: string;
  fileName?: string;
}

interface DownloadRemoteFileResult {
  saved: boolean;
  canceled?: boolean;
  filePath?: string | null;
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

interface SpotifyOAuthCallbackPayload {
  url: string;
  receivedAt: number;
}

interface GetPendingSpotifyOAuthCallbackPayload {
  consume?: boolean;
}

interface GetPendingSpotifyOAuthCallbackResult {
  url: string | null;
  receivedAt: number | null;
}

interface SpotifyPresenceChannelPayload {
  scope?: string | null;
  clientId?: string;
  redirectUri?: string;
}

interface SpotifyPresenceVisibilityPayload extends SpotifyPresenceChannelPayload {
  showOnProfile?: boolean;
  showAsStatus?: boolean;
}

interface SpotifyPresencePlaybackState {
  trackTitle: string;
  artistNames: string;
  coverUrl: string;
  trackUrl: string;
  trackId: string;
  progressSeconds: number;
  durationSeconds: number;
  isPlaying?: boolean;
  deviceId?: string;
  deviceName?: string;
}

interface SpotifyPresenceConnectionState {
  v: 1;
  provider: "spotify";
  authState: "oauth" | "detached";
  connected: boolean;
  accountName: string;
  accountId: string;
  accountUrl: string;
  accountProduct: string;
  showOnProfile: boolean;
  showAsStatus: boolean;
  playback: SpotifyPresencePlaybackState | null;
  token: null;
  updatedAt: string;
}

interface SpotifyPresenceActivityState {
  provider: "spotify";
  trackId: string;
  trackTitle: string;
  artistNames: string;
  trackUrl: string;
  coverUrl: string;
  progressSeconds: number;
  durationSeconds: number;
  isPlaying?: boolean;
  startedAt?: number;
  endsAt?: number;
  updatedAt: number;
  showOnProfile?: boolean;
}

interface SpotifyPresenceSchedulerState {
  reason: string;
  nextDelayMs: number;
  backoffAttempt: number;
  pollInFlight: boolean;
  started: boolean;
  subscribers: number;
  lastRequestAt: number;
  lastResponseAt: number;
  lastError: string;
}

interface SpotifyPresenceStateResult {
  scope: string;
  connection: SpotifyPresenceConnectionState;
  activity: SpotifyPresenceActivityState | null;
  scheduler?: SpotifyPresenceSchedulerState;
}

interface SpotifyPresenceUpdatePayload extends SpotifyPresenceStateResult {}

interface SetWindowAttentionPayload {
  enabled: boolean;
}

interface SetWindowAttentionResult {
  enabled: boolean;
}

interface MessageNotificationPayload {
  conversationId: string;
  messageId: string;
  eventId?: string;
  authorId: string;
  authorName?: string;
  contentPreview?: string;
  createdAt?: string | null;
  avatarUrl?: string;
  conversationType?: "dm" | "group" | "channel" | "guild" | "unknown";
  contextLabel?: string;
  messageType?: "text" | "image" | "video" | "file";
  attachmentMimeType?: string;
  attachmentCount?: number;
  batchCount?: number;
  muted?: boolean;
}

interface VoiceCallNotificationPayload {
  conversationId: string;
  roomId: string;
  callerUserId: string;
  callerName?: string;
  callerAvatarUrl?: string;
  sentAt?: number;
}

interface MessageNotificationOpenPayload {
  conversationId: string;
  messageId?: string;
  eventId?: string;
  source?: string;
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
  | "applying"
  | "installing"
  | "relaunching"
  | "retrying"
  | "ready"
  | "failed"
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
  bytesPerSecond?: number;
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

interface WindowsFirewallRuleSnapshot {
  ruleName: string;
  direction: string;
  profiles: string;
  program: string;
  enabled: string;
}

interface WindowsNetworkDiagnosticsSnapshot {
  platform: string;
  timestamp: string;
  ruleName: string;
  executablePath: string;
  expectedProfiles?: string[];
  hasExpectedRule?: boolean;
  currentProfileRaw?: string;
  firewallRules?: WindowsFirewallRuleSnapshot[];
  supported?: boolean;
  reason?: string;
}

interface ElectronStartupSnapshotApiConfig {
  supabaseUrl: string | null;
  gatewayUrl: string | null;
  authApiUrl: string | null;
  appApiUrl: string | null;
  webOrigin?: string | null;
  shellOrigin?: string | null;
  mediaProxyUrl?: string | null;
}

interface ElectronStartupSnapshotCacheHints {
  hiddenScopeCount: number;
  hiddenConversationCount: number;
}

interface ElectronStartupPerformanceMark {
  name: string;
  atMs: number;
  details?: Record<string, unknown>;
}

interface ElectronStartupPerformanceMetrics {
  processEntryToWhenReadyMs: number | null;
  processEntryToCreateWindowMs: number | null;
  processEntryToWindowReadyToShowMs: number | null;
  processEntryToFirstFrameMs: number | null;
  processEntryToWindowRevealMs: number | null;
}

interface ElectronStartupPerformanceSnapshot {
  marks: ElectronStartupPerformanceMark[];
  metrics: ElectronStartupPerformanceMetrics;
}

interface ElectronStartupSnapshot {
  generatedAt: string;
  appVersion: string | null;
  hasRefreshToken: boolean;
  secureStorageAvailable: boolean;
  windowsSettings: WindowsBehaviorSettings | null;
  apiConfig: ElectronStartupSnapshotApiConfig | null;
  cacheHints: ElectronStartupSnapshotCacheHints | null;
  startupPerformance?: ElectronStartupPerformanceSnapshot | null;
}

interface RendererFirstFrameReadyPayload {
  surface: "shell" | "auth";
  route: string;
  bootstrapPhase?: string | null;
}

interface HiddenDirectMessageConversationIdsPayload {
  scopes: string[];
  conversationIds?: string[];
}

interface HiddenDirectMessageConversationIdsResult {
  conversationIds: string[];
}

interface SecureStoreItemPayload {
  key: string;
}

interface SecureStoreItemResult {
  value: string | null;
  persistent: boolean;
}

interface SetSecureStoreItemPayload {
  key: string;
  value: string;
}

interface SetSecureStoreItemResult {
  stored: boolean;
  persistent: boolean;
}

interface RemoveSecureStoreItemPayload {
  key: string;
}

interface RemoveSecureStoreItemResult {
  removed: boolean;
  persistent: boolean;
}

interface RendererDiagnosticPayload {
  source: string;
  event: string;
  level?: "debug" | "info" | "warn" | "error";
  details?: Record<string, unknown>;
}

interface RendererDiagnosticResult {
  ok: boolean;
  recordedAt: string;
}

interface MesslyAuthApi {
  saveRefreshToken?: (token: string) => Promise<void>;
  loadRefreshToken?: () => Promise<string | null>;
  clearRefreshToken?: () => Promise<void>;
}

interface ElectronApi {
  platform: string;
  arch?: string;
  isPackaged?: boolean;
  getStartupSnapshot?: () => Promise<ElectronStartupSnapshot>;
  signalRendererFirstFrameReady?: (payload: RendererFirstFrameReadyPayload) => void;
  getSignedMediaUrl?: (payload: GetSignedMediaUrlPayload) => Promise<GetSignedMediaUrlResult>;
  uploadProfileMedia?: (payload: UploadProfileMediaPayload) => Promise<UploadProfileMediaResult>;
  uploadAttachment?: (payload: UploadAttachmentPayload) => Promise<UploadAttachmentResult>;
  downloadRemoteFile?: (payload: DownloadRemoteFilePayload) => Promise<DownloadRemoteFileResult>;
  openExternalUrl?: (payload: OpenExternalUrlPayload) => Promise<OpenExternalUrlResult>;
  getPendingSpotifyOAuthCallback?: (
    payload?: GetPendingSpotifyOAuthCallbackPayload,
  ) => Promise<GetPendingSpotifyOAuthCallbackResult>;
  spotifyPresenceGetState?: (payload?: SpotifyPresenceChannelPayload) => Promise<SpotifyPresenceStateResult>;
  spotifyPresenceConnect?: (payload?: SpotifyPresenceChannelPayload) => Promise<SpotifyPresenceStateResult>;
  spotifyPresenceDisconnect?: (payload?: SpotifyPresenceChannelPayload) => Promise<SpotifyPresenceStateResult>;
  spotifyPresenceSetVisibility?: (payload: SpotifyPresenceVisibilityPayload) => Promise<SpotifyPresenceStateResult>;
  spotifyPresenceStart?: (payload?: SpotifyPresenceChannelPayload) => Promise<SpotifyPresenceStateResult>;
  spotifyPresenceStop?: (payload?: SpotifyPresenceChannelPayload) => Promise<SpotifyPresenceStateResult>;
  spotifyPresencePollOnce?: (payload?: SpotifyPresenceChannelPayload) => Promise<SpotifyPresenceConnectionState>;
  spotifyPresenceDebugState?: (payload?: SpotifyPresenceChannelPayload) => Promise<SpotifyPresenceStateResult>;
  getScreenShareSources?: (options?: ScreenShareSourceOptions) => Promise<ScreenShareSource[]>;
  setWindowAttention?: (payload: SetWindowAttentionPayload) => Promise<SetWindowAttentionResult>;
  updaterGetState?: () => Promise<AppUpdaterState | null>;
  updaterCheck?: () => Promise<AppUpdaterState>;
  updaterDownload?: () => Promise<AppUpdaterDownloadResult>;
  updaterInstall?: () => Promise<AppUpdaterInstallResult>;
  getWindowsSettings?: () => Promise<WindowsBehaviorSettings>;
  updateWindowsSettings?: (payload: Partial<WindowsBehaviorSettings>) => Promise<WindowsBehaviorSettings>;
  restoreMainWindowFromTray?: () => Promise<WindowsBehaviorSettingsRestoreResult>;
  getWindowsNetworkDiagnostics?: () => Promise<WindowsNetworkDiagnosticsSnapshot>;
  getHiddenDirectMessageConversationIds?: (
    payload: HiddenDirectMessageConversationIdsPayload,
  ) => Promise<HiddenDirectMessageConversationIdsResult>;
  setHiddenDirectMessageConversationIds?: (
    payload: HiddenDirectMessageConversationIdsPayload,
  ) => Promise<HiddenDirectMessageConversationIdsResult>;
  getSecureStoreItem?: (payload: SecureStoreItemPayload) => Promise<SecureStoreItemResult>;
  setSecureStoreItem?: (payload: SetSecureStoreItemPayload) => Promise<SetSecureStoreItemResult>;
  removeSecureStoreItem?: (payload: RemoveSecureStoreItemPayload) => Promise<RemoveSecureStoreItemResult>;
  logDiagnostic?: (payload: RendererDiagnosticPayload) => Promise<RendererDiagnosticResult>;
  onUpdaterStateChanged?: (listener: (state: AppUpdaterState) => void) => () => void;
  onSpotifyOAuthCallback?: (listener: (payload: SpotifyOAuthCallbackPayload) => void) => () => void;
  onSpotifyPresenceUpdate?: (listener: (payload: SpotifyPresenceUpdatePayload) => void) => () => void;
  versions: {
    chrome: string;
    electron: string;
    node: string;
  };
}

interface NotificationsApi {
  notifyMessage?: (payload: MessageNotificationPayload) => Promise<{ ok: boolean; reason?: string }>;
  notifyCall?: (payload: VoiceCallNotificationPayload) => Promise<{ ok: boolean; reason?: string }>;
  onOpenConversation?: (listener: (payload: MessageNotificationOpenPayload) => void) => () => void;
  notifyRendererReady?: () => void;
  consumePendingOpenConversations?: () => MessageNotificationOpenPayload[];
}

interface Window {
  electronAPI?: ElectronApi;
  messlyAuth?: MesslyAuthApi;
  notifications?: NotificationsApi;
  __messlyAuthState?: {
    currentSession: import("@supabase/supabase-js").Session | null;
    currentAccessToken: string | null;
    currentUserId: string | null;
  };
}
