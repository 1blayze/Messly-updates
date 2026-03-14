import type { SupabaseClient } from "@supabase/supabase-js";
import { validateSupabaseJwt } from "../auth/validateSupabaseJwt";
import type { RateLimiter } from "../edge/rateLimiter";
import type { GatewayEnv } from "../infra/env";
import type { Logger } from "../infra/logger";
import type { AuthSessionManager } from "../sessions/sessionManager";
import { buildCdnUrl, MediaR2Client } from "./r2";
import { processProfileMediaUpload, ProfileMediaProcessorError } from "./profileProcessors";

const SHA256_REGEX = /^[a-f0-9]{64}$/i;
const SAFE_FILE_NAME_REGEX = /[^a-zA-Z0-9._-]/g;
const DEFAULT_SIGNED_UPLOAD_TTL_SECONDS = 900;
export type MediaUploadKind =
  | "avatar"
  | "banner"
  | "message_image"
  | "message_image_preview"
  | "message_image_original"
  | "message_video"
  | "message_video_preview"
  | "message_video_thumb"
  | "message_file";

export interface CreateUploadInput {
  kind: MediaUploadKind;
  sha256: string;
  contentType: string;
  sizeBytes: number;
  fileName?: string | null;
  conversationId?: string | null;
}

export interface CreateUploadOutput {
  uploadUrl: string | null;
  uploadHeaders: Record<string, string>;
  fileKey: string;
  cdnUrl: string;
  alreadyExists: boolean;
  expiresInSeconds: number;
}

export interface DeleteMediaInput {
  fileKey: string;
}

export interface DeleteMediaOutput {
  deleted: boolean;
  fileKey: string;
  reason: "deleted" | "still_referenced" | "not_found";
  references: number;
}

export interface ProxyUploadInput {
  fileKey: string;
  contentType: string;
  body: Buffer;
}

export interface UploadProfileMediaInput {
  kind: "avatar" | "banner";
  fileName?: string | null;
  contentType: string;
  body: Buffer;
}

export interface UploadProfileMediaOutput {
  uploaded: true;
  kind: "avatar" | "banner";
  key: string;
  hash: string;
  size: number;
  contentType: string;
  cdnUrl: string;
  versionedUrl: string;
  strategy: "server-proxy";
  persistedProfile: {
    avatar_key?: string | null;
    avatar_hash?: string | null;
    avatar_url?: string | null;
    banner_key?: string | null;
    banner_hash?: string | null;
    banner_url?: string | null;
  };
}

export interface CleanupOrphanFilesOutput {
  scanned: number;
  deleted: string[];
  retained: string[];
}

interface MediaServiceOptions {
  adminSupabase: SupabaseClient;
  sessionManager: AuthSessionManager;
  rateLimiter: RateLimiter;
  env: GatewayEnv;
  logger?: Logger;
}

export class MediaServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly headers?: Record<string, string>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "MediaServiceError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

function normalizeContentType(contentTypeRaw: string): string {
  const normalized = String(contentTypeRaw ?? "").trim().toLowerCase();
  if (!normalized) {
    throw new MediaServiceError(400, "INVALID_CONTENT_TYPE", "contentType obrigatorio.");
  }
  return normalized;
}

function assertUuid(value: string | null | undefined, fieldName: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new MediaServiceError(400, "INVALID_UUID", `${fieldName} invalido.`);
  }
  return normalized;
}

function sanitizeFileName(fileNameRaw: string | null | undefined): string {
  const normalized = String(fileNameRaw ?? "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(SAFE_FILE_NAME_REGEX, "");
  return normalized.slice(-160) || "upload.bin";
}

function getFileExtension(fileName: string, fallback: string): string {
  const extension = fileName.split(".").pop()?.trim().toLowerCase();
  return extension || fallback;
}

function getProfileMediaExtensionFromContentType(contentTypeRaw: string, fallback: string): string {
  const contentType = String(contentTypeRaw ?? "").trim().toLowerCase();
  if (contentType === "image/gif") {
    return "gif";
  }
  if (contentType === "image/png") {
    return "png";
  }
  if (contentType === "image/jpeg") {
    return "jpg";
  }
  if (contentType === "image/webp") {
    return "webp";
  }
  return fallback;
}

function sanitizeSha256(sha256Raw: string): string {
  const normalized = String(sha256Raw ?? "").trim().toLowerCase();
  if (!SHA256_REGEX.test(normalized)) {
    throw new MediaServiceError(400, "INVALID_SHA256", "sha256 invalido.");
  }
  return normalized;
}

function sanitizeFileKey(fileKeyRaw: string): string {
  const normalized = String(fileKeyRaw ?? "").trim().replace(/^\/+/, "");
  if (
    !normalized ||
    normalized.includes("..") ||
    normalized.includes("\\") ||
    normalized.includes("//") ||
    !/^[a-z0-9/_\-.]+$/i.test(normalized)
  ) {
    throw new MediaServiceError(400, "INVALID_FILE_KEY", "fileKey invalido.");
  }
  return normalized;
}

function assertUploadSize(kind: MediaUploadKind, sizeBytes: number): void {
  const numericSize = Number(sizeBytes);
  if (!Number.isFinite(numericSize) || numericSize <= 0) {
    throw new MediaServiceError(400, "INVALID_FILE_SIZE", "sizeBytes invalido.");
  }

  const maxBytes =
    kind === "avatar" || kind === "banner" || kind === "message_image" || kind === "message_image_preview"
      ? 10 * 1024 * 1024
      : kind === "message_video" || kind === "message_video_preview" || kind === "message_video_thumb"
        ? 100 * 1024 * 1024
        : 25 * 1024 * 1024;

  if (numericSize > maxBytes) {
    throw new MediaServiceError(413, "MEDIA_FILE_TOO_LARGE", "Arquivo acima do limite permitido.", {
      maxBytes,
      sizeBytes: numericSize,
      kind,
    });
  }
}

function assertContentType(kind: MediaUploadKind, contentType: string): void {
  const imageTypes = new Set(["image/webp", "image/png", "image/jpeg", "image/gif"]);
  const videoTypes = new Set(["video/mp4", "video/webm", "video/quicktime"]);
  const fileTypes = new Set([
    "application/pdf",
    "text/plain",
    "application/zip",
    "application/x-zip-compressed",
  ]);

  if (
    (kind === "avatar" || kind === "banner" || kind === "message_image" || kind === "message_image_preview")
    && !imageTypes.has(contentType)
  ) {
    throw new MediaServiceError(400, "UNSUPPORTED_MEDIA_TYPE", "Tipo de imagem nao permitido.");
  }

  if ((kind === "message_video" || kind === "message_video_preview") && !videoTypes.has(contentType)) {
    throw new MediaServiceError(400, "UNSUPPORTED_MEDIA_TYPE", "Tipo de video nao permitido.");
  }

  if (kind === "message_video_thumb" && contentType !== "image/webp") {
    throw new MediaServiceError(400, "UNSUPPORTED_MEDIA_TYPE", "Thumbnail de video deve ser image/webp.");
  }

  if ((kind === "message_file" || kind === "message_image_original") && !fileTypes.has(contentType) && !contentType.startsWith("image/")) {
    throw new MediaServiceError(400, "UNSUPPORTED_MEDIA_TYPE", "Tipo de arquivo nao permitido.");
  }
}

function resolveUploadKey(userId: string, input: CreateUploadInput): string {
  const safeName = sanitizeFileName(input.fileName);

  switch (input.kind) {
    case "avatar": {
      const extension = getProfileMediaExtensionFromContentType(input.contentType, getFileExtension(safeName, "webp"));
      return `avatars/${userId}.${extension}`;
    }
    case "banner": {
      const extension = getProfileMediaExtensionFromContentType(input.contentType, getFileExtension(safeName, "webp"));
      return `banners/${userId}.${extension}`;
    }
    case "message_image":
      return `messages/images/${input.sha256}.webp`;
    case "message_image_preview":
      return `messages/images/${input.sha256}.preview.webp`;
    case "message_image_original":
      return `messages/files/${input.sha256}.${getFileExtension(safeName, "bin")}`;
    case "message_video":
      return `messages/videos/${input.sha256}.${getFileExtension(safeName, "mp4")}`;
    case "message_video_preview":
      return `messages/videos/${input.sha256}.preview.mp4`;
    case "message_video_thumb":
      return `messages/videos/${input.sha256}.thumb.webp`;
    case "message_file":
      return `messages/files/${input.sha256}.${getFileExtension(safeName, "bin")}`;
    default:
      return `messages/files/${input.sha256}.bin`;
  }
}

function requiresConversation(kind: MediaUploadKind): boolean {
  return kind.startsWith("message_");
}

function appendVersionToUrl(url: string, hash: string): string {
  const normalizedHash = String(hash ?? "").trim().toLowerCase();
  if (!normalizedHash) {
    return url;
  }

  try {
    const parsed = new URL(url);
    parsed.searchParams.set("v", normalizedHash);
    return parsed.toString();
  } catch {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}v=${encodeURIComponent(normalizedHash)}`;
  }
}

function toMediaServiceErrorFromProcessor(error: ProfileMediaProcessorError): MediaServiceError {
  const code = String(error.code ?? "").trim().toUpperCase();
  const status = code === "FILE_TOO_LARGE" ? 413 : 400;
  return new MediaServiceError(status, code || "INVALID_IMAGE", error.message, error.details);
}

export class MediaService {
  private readonly r2: MediaR2Client;

  constructor(private readonly options: MediaServiceOptions) {
    this.r2 = new MediaR2Client(options.env);
  }

  private buildPublicMediaUrl(fileKey: string): string {
    const url = buildCdnUrl(this.options.env.mediaCdnBaseUrl, fileKey);
    this.options.logger?.info("media public url generated", {
      mode: String(process.env.NODE_ENV ?? "").trim().toLowerCase() === "production" ? "production" : "development",
      fileKey,
      url,
    });
    return url;
  }

  async createUpload(accessToken: string, input: CreateUploadInput, ipAddress: string): Promise<CreateUploadOutput> {
    const user = await this.authenticate(accessToken);
    const normalizedInput = this.normalizeCreateUploadInput(input);

    await this.enforceRateLimit(`media:create:${user.id}`, 40, 60_000);
    await this.enforceRateLimit(`media:create-ip:${ipAddress}`, 80, 60_000);

    const fileKey = resolveUploadKey(user.id, normalizedInput);
    if (normalizedInput.conversationId) {
      await this.assertConversationMembership(user.id, normalizedInput.conversationId);
    }

    let registryAvailable = true;
    let existingAuthorization: { id: string; sha256: string; status: string } | null = null;
    try {
      existingAuthorization = await this.findAuthorizationRow(user.id, fileKey, normalizedInput.conversationId ?? null);
    } catch (error) {
      if (this.isMediaRegistryMissingError(error)) {
        registryAvailable = false;
        if (requiresConversation(normalizedInput.kind)) {
          throw error;
        }
      } else {
        throw error;
      }
    }
    const objectExists = await this.r2.objectExists(fileKey);
    const alreadyExists =
      normalizedInput.kind === "avatar" || normalizedInput.kind === "banner"
        ? objectExists && existingAuthorization?.sha256 === normalizedInput.sha256 && existingAuthorization.status !== "deleted"
        : objectExists;

    if (registryAvailable) {
      await this.upsertAuthorizationRow(user.id, fileKey, normalizedInput, alreadyExists ? "uploaded" : "pending");
    }

    if (alreadyExists) {
      const cdnUrl = this.buildPublicMediaUrl(fileKey);
      return {
        uploadUrl: null,
        uploadHeaders: {},
        fileKey,
        cdnUrl,
        alreadyExists: true,
        expiresInSeconds: DEFAULT_SIGNED_UPLOAD_TTL_SECONDS,
      };
    }

    const signed = await this.r2.createSignedPutUrl(
      fileKey,
      normalizedInput.contentType,
      DEFAULT_SIGNED_UPLOAD_TTL_SECONDS,
    );

    const cdnUrl = this.buildPublicMediaUrl(fileKey);
    return {
      uploadUrl: signed.url,
      uploadHeaders: signed.headers,
      fileKey,
      cdnUrl,
      alreadyExists: false,
      expiresInSeconds: signed.expiresInSeconds,
    };
  }

  async deleteMedia(accessToken: string, input: DeleteMediaInput): Promise<DeleteMediaOutput> {
    const user = await this.authenticate(accessToken);
    const fileKey = sanitizeFileKey(input.fileKey);

    await this.assertDeletePermission(user.id, fileKey);

    const references = await this.countActiveReferences(fileKey);
    if (references > 0) {
      return {
        deleted: false,
        fileKey,
        reason: "still_referenced",
        references,
      };
    }

    const exists = await this.r2.objectExists(fileKey);
    if (!exists) {
      await this.markAuthorizationStatus(fileKey, user.id, "deleted");
      return {
        deleted: false,
        fileKey,
        reason: "not_found",
        references: 0,
      };
    }

    await this.r2.deleteObject(fileKey);
    await this.markAuthorizationStatus(fileKey, user.id, "deleted");

    return {
      deleted: true,
      fileKey,
      reason: "deleted",
      references: 0,
    };
  }

  async proxyUpload(accessToken: string, input: ProxyUploadInput, ipAddress: string): Promise<{ uploaded: true; fileKey: string }> {
    const user = await this.authenticate(accessToken);
    const fileKey = sanitizeFileKey(input.fileKey);
    const contentType = normalizeContentType(input.contentType);
    const sizeBytes = Buffer.byteLength(input.body);

    await this.enforceRateLimit(`media:proxy:${user.id}`, 20, 60_000);
    await this.enforceRateLimit(`media:proxy-ip:${ipAddress}`, 40, 60_000);

    this.assertProxyUploadPermission(user.id, fileKey);
    this.assertProxyUploadSize(fileKey, sizeBytes);
    this.assertProxyUploadContentType(fileKey, contentType);

    await this.r2.uploadObject(fileKey, input.body, contentType);

    try {
      await this.markAuthorizationStatus(fileKey, user.id, "uploaded");
    } catch (error) {
      if (!this.isMediaRegistryMissingError(error)) {
        throw error;
      }
    }

    return {
      uploaded: true,
      fileKey,
    };
  }

  async uploadProfileMedia(
    accessToken: string,
    input: UploadProfileMediaInput,
    ipAddress: string,
  ): Promise<UploadProfileMediaOutput> {
    const user = await this.authenticate(accessToken);
    const kind = input.kind;
    const body = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body);

    await this.enforceRateLimit(`media:profile-upload:${user.id}`, 20, 60_000);
    await this.enforceRateLimit(`media:profile-upload-ip:${ipAddress}`, 40, 60_000);

    this.options.logger?.info("Profile media upload started", {
      event: "upload start",
      environment: "server-proxy",
      userId: user.id,
      kind,
      ipAddress,
      reportedContentType: normalizeContentType(input.contentType),
      fileName: sanitizeFileName(input.fileName),
      sizeBytes: body.length,
      strategy: "server-proxy",
    });

    let processed;
    try {
      processed = await processProfileMediaUpload(kind, body);
    } catch (error) {
      if (error instanceof ProfileMediaProcessorError) {
        throw toMediaServiceErrorFromProcessor(error);
      }
      throw error;
    }

    const key = `${kind === "avatar" ? "avatars" : "banners"}/${user.id}.${processed.ext}`;
    const normalizedUploadInput: CreateUploadInput = {
      kind,
      sha256: processed.hash,
      contentType: processed.contentType,
      sizeBytes: processed.size,
      fileName: sanitizeFileName(input.fileName),
      conversationId: null,
    };

    this.options.logger?.info("Profile media upload endpoint", {
      event: "upload endpoint",
      environment: "server-proxy",
      userId: user.id,
      kind,
      key,
      bucket: this.options.env.r2Bucket,
      contentType: processed.contentType,
      sizeBytes: processed.size,
      strategy: "server-proxy",
      method: "PUT",
    });

    try {
      await this.r2.uploadObject(key, processed.buffer, processed.contentType);
    } catch (error) {
      this.options.logger?.error("Profile media upload failed", {
        event: "upload error",
        environment: "server-proxy",
        userId: user.id,
        kind,
        key,
        bucket: this.options.env.r2Bucket,
        strategy: "server-proxy",
        failureType: "storage",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    this.options.logger?.info("Profile media upload response", {
      event: "upload response",
      environment: "server-proxy",
      userId: user.id,
      kind,
      key,
      bucket: this.options.env.r2Bucket,
      contentType: processed.contentType,
      sizeBytes: processed.size,
      strategy: "server-proxy",
    });

    try {
      await this.upsertAuthorizationRow(user.id, key, normalizedUploadInput, "uploaded");
    } catch (error) {
      if (!this.isMediaRegistryMissingError(error)) {
        throw error;
      }
    }

    const cdnUrl = this.buildPublicMediaUrl(key);
    const versionedUrl = appendVersionToUrl(cdnUrl, processed.hash);

    const persistedProfile =
      kind === "avatar"
        ? {
            avatar_key: key,
            avatar_hash: processed.hash,
            avatar_url: versionedUrl,
          }
        : {
            banner_key: key,
            banner_hash: processed.hash,
            banner_url: versionedUrl,
          };

    const { data, error } = await this.options.adminSupabase
      .from("profiles")
      .update(persistedProfile)
      .eq("id", user.id)
      .select("id")
      .maybeSingle();

    if (error) {
      throw new MediaServiceError(500, "PROFILE_PERSISTENCE_FAILED", "Falha ao persistir a midia de perfil.", {
        kind,
        fileKey: key,
        code: error.code,
        details: error.details,
      });
    }

    if (!data?.id) {
      throw new MediaServiceError(404, "PROFILE_NOT_FOUND", "Perfil nao encontrado para persistir a midia.");
    }

    this.options.logger?.info("Profile media upload persisted", {
      event: "upload persisted profile",
      environment: "server-proxy",
      userId: user.id,
      kind,
      key,
      hash: processed.hash,
      size: processed.size,
      contentType: processed.contentType,
      strategy: "server-proxy",
    });

    return {
      uploaded: true,
      kind,
      key,
      hash: processed.hash,
      size: processed.size,
      contentType: processed.contentType,
      cdnUrl,
      versionedUrl,
      strategy: "server-proxy",
      persistedProfile,
    };
  }

  async getPublicReadUrl(fileKeyRaw: string): Promise<string> {
    const fileKey = sanitizeFileKey(fileKeyRaw);
    this.assertPublicReadKey(fileKey);

    const signed = await this.r2.createSignedGetUrl(fileKey, DEFAULT_SIGNED_UPLOAD_TTL_SECONDS);
    return signed.url;
  }

  async cleanupOrphanFiles(): Promise<CleanupOrphanFilesOutput> {
    this.r2.assertConfigured();

    const [allKeys, referencedKeys] = await Promise.all([
      this.r2.listManagedKeys(),
      this.collectReferencedKeys(),
    ]);

    const deleted: string[] = [];
    const retained: string[] = [];
    for (const key of allKeys) {
      if (referencedKeys.has(key)) {
        retained.push(key);
        continue;
      }

      await this.r2.deleteObject(key);
      deleted.push(key);
      await this.markAuthorizationStatus(key, null, "deleted");
    }

    return {
      scanned: allKeys.length,
      deleted,
      retained,
    };
  }

  private normalizeCreateUploadInput(input: CreateUploadInput): CreateUploadInput {
    const kind = input.kind;
    const sha256 = sanitizeSha256(input.sha256);
    const contentType = normalizeContentType(input.contentType);
    assertUploadSize(kind, input.sizeBytes);
    assertContentType(kind, contentType);

    const normalized: CreateUploadInput = {
      kind,
      sha256,
      contentType,
      sizeBytes: Math.trunc(input.sizeBytes),
      fileName: sanitizeFileName(input.fileName),
      conversationId: input.conversationId ? assertUuid(input.conversationId, "conversationId") : null,
    };

    if (requiresConversation(kind) && !normalized.conversationId) {
      throw new MediaServiceError(400, "MISSING_CONVERSATION_ID", "conversationId obrigatorio para uploads de mensagem.");
    }

    if ((kind === "avatar" || kind === "banner") && normalized.conversationId) {
      throw new MediaServiceError(400, "INVALID_MEDIA_SCOPE", "Uploads de perfil nao aceitam conversationId.");
    }

    return normalized;
  }

  private assertPublicReadKey(fileKey: string): void {
    if (
      !fileKey.startsWith("avatars/")
      && !fileKey.startsWith("banners/")
      && !fileKey.startsWith("messages/")
      && !fileKey.startsWith("attachments/")
    ) {
      throw new MediaServiceError(400, "INVALID_FILE_KEY", "fileKey invalido.");
    }
  }

  private assertProxyUploadPermission(userId: string, fileKey: string): void {
    if (this.isOwnedProfileMediaKey(userId, fileKey)) {
      return;
    }

    throw new MediaServiceError(403, "FORBIDDEN", "Sem permissao para enviar essa midia.");
  }

  private isOwnedProfileMediaKey(userId: string, fileKey: string): boolean {
    return fileKey.startsWith(`avatars/${userId}.`) || fileKey.startsWith(`banners/${userId}.`);
  }

  private assertProxyUploadSize(fileKey: string, sizeBytes: number): void {
    const kind: MediaUploadKind = fileKey.startsWith("avatars/")
      ? "avatar"
      : fileKey.startsWith("banners/")
        ? "banner"
        : "message_file";
    assertUploadSize(kind, sizeBytes);
  }

  private assertProxyUploadContentType(fileKey: string, contentType: string): void {
    const kind: MediaUploadKind = fileKey.startsWith("avatars/")
      ? "avatar"
      : fileKey.startsWith("banners/")
        ? "banner"
        : "message_file";
    assertContentType(kind, contentType);
  }

  private async authenticate(accessToken: string): Promise<{ id: string; authSessionId: string }> {
    this.r2.assertConfigured();

    const normalizedToken = String(accessToken ?? "").trim();
    if (!normalizedToken) {
      throw new MediaServiceError(401, "UNAUTHORIZED", "JWT obrigatorio.");
    }

    const user = await validateSupabaseJwt(this.options.adminSupabase, normalizedToken, this.options.sessionManager);
    if (!user) {
      throw new MediaServiceError(401, "UNAUTHORIZED", "JWT invalido.");
    }

    return user;
  }

  private async enforceRateLimit(key: string, limit: number, windowMs: number): Promise<void> {
    const outcome = await this.options.rateLimiter.consume(key, limit, windowMs);
    if (!outcome.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(outcome.retryAfterMs / 1000));
      throw new MediaServiceError(
        429,
        "MEDIA_RATE_LIMITED",
        "Muitas operacoes de midia. Tente novamente em instantes.",
        {
          limit,
          windowMs,
          retryAfterMs: outcome.retryAfterMs,
        },
        {
          "retry-after": String(retryAfterSeconds),
        },
      );
    }
  }

  private async assertConversationMembership(userId: string, conversationId: string): Promise<void> {
    const directResult = await this.options.adminSupabase
      .from("conversations")
      .select("id,user1_id,user2_id")
      .eq("id", conversationId)
      .maybeSingle();

    if (!directResult.error && directResult.data) {
      const isMember =
        String(directResult.data.user1_id ?? "") === userId || String(directResult.data.user2_id ?? "") === userId;
      if (isMember) {
        return;
      }
    }

    const memberResult = await this.options.adminSupabase
      .from("conversation_members")
      .select("conversation_id")
      .eq("conversation_id", conversationId)
      .eq("user_id", userId)
      .maybeSingle();

    const isMember =
      !memberResult.error && memberResult.data !== null && String(memberResult.data.conversation_id ?? "") === conversationId;
    if (!isMember) {
      throw new MediaServiceError(403, "FORBIDDEN", "Sem permissao para essa conversa.");
    }
  }

  private async upsertAuthorizationRow(
    userId: string,
    fileKey: string,
    input: CreateUploadInput,
    status: "pending" | "uploaded" | "attached" | "deleted",
  ): Promise<void> {
    const existing = await this.findAuthorizationRow(userId, fileKey, input.conversationId ?? null);

    const payload = {
      file_key: fileKey,
      owner_user_id: userId,
      conversation_id: input.conversationId ?? null,
      kind: input.kind,
      sha256: input.sha256,
      content_type: input.contentType,
      size_bytes: input.sizeBytes,
      status,
      metadata: {
        originalFileName: input.fileName ?? null,
      },
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (existing?.id) {
      const { error } = await this.options.adminSupabase
        .from("media_uploads")
        .update(payload)
        .eq("id", existing.id);
      if (error) {
        throw new MediaServiceError(500, "MEDIA_UPLOAD_REGISTRY_FAILED", "Falha ao registrar autorizacao de upload.");
      }
      return;
    }

    const { error } = await this.options.adminSupabase.from("media_uploads").insert(payload);
    if (error) {
      if (this.isMissingMediaRegistryTableError(error)) {
        throw new MediaServiceError(
          503,
          "MEDIA_SCHEMA_MISSING",
          "A migration de media_uploads ainda nao foi aplicada no banco.",
          {
            requiredMigration: "20260308013000_media_uploads_and_object_prefixes.sql",
          },
        );
      }
      if (error.code === "23505") {
        const retryExisting = await this.findAuthorizationRow(userId, fileKey, input.conversationId ?? null);
        if (retryExisting?.id) {
          const retryUpdate = await this.options.adminSupabase
            .from("media_uploads")
            .update(payload)
            .eq("id", retryExisting.id);
          if (!retryUpdate.error) {
            return;
          }
        }
      }
      throw new MediaServiceError(500, "MEDIA_UPLOAD_REGISTRY_FAILED", "Falha ao registrar autorizacao de upload.");
    }
  }

  private async findAuthorizationRow(
    userId: string,
    fileKey: string,
    conversationId: string | null,
  ): Promise<{ id: string; sha256: string; status: string } | null> {
    let query = this.options.adminSupabase
      .from("media_uploads")
      .select("id,sha256,status")
      .eq("file_key", fileKey)
      .eq("owner_user_id", userId);

    query = conversationId ? query.eq("conversation_id", conversationId) : query.is("conversation_id", null);

    const { data, error } = await query.maybeSingle();
    if (error) {
      if (this.isMissingMediaRegistryTableError(error)) {
        throw new MediaServiceError(
          503,
          "MEDIA_SCHEMA_MISSING",
          "A migration de media_uploads ainda nao foi aplicada no banco.",
          {
            requiredMigration: "20260308013000_media_uploads_and_object_prefixes.sql",
          },
        );
      }
      return null;
    }

    if (!data) {
      return null;
    }

    return {
      id: String((data as { id?: string }).id ?? ""),
      sha256: String((data as { sha256?: string }).sha256 ?? "").trim().toLowerCase(),
      status: String((data as { status?: string }).status ?? "").trim().toLowerCase(),
    };
  }

  private async assertDeletePermission(userId: string, fileKey: string): Promise<void> {
    if (this.isOwnedProfileMediaKey(userId, fileKey)) {
      return;
    }

    const ownAuthorization = await this.options.adminSupabase
      .from("media_uploads")
      .select("id")
      .eq("file_key", fileKey)
      .eq("owner_user_id", userId)
      .limit(1);

    if (ownAuthorization.error && !this.isMissingMediaRegistryTableError(ownAuthorization.error)) {
      throw new MediaServiceError(500, "MEDIA_UPLOAD_LOOKUP_FAILED", "Falha ao validar permissao de exclusao.");
    }

    if (!ownAuthorization.error && (ownAuthorization.data?.length ?? 0) > 0) {
      return;
    }

    const avatarRef = await this.options.adminSupabase
      .from("profiles")
      .select("id")
      .eq("id", userId)
      .eq("avatar_key", fileKey)
      .maybeSingle();
    if (!avatarRef.error && avatarRef.data?.id) {
      return;
    }

    const bannerRef = await this.options.adminSupabase
      .from("profiles")
      .select("id")
      .eq("id", userId)
      .eq("banner_key", fileKey)
      .maybeSingle();
    if (!bannerRef.error && bannerRef.data?.id) {
      return;
    }

    throw new MediaServiceError(403, "FORBIDDEN", "Sem permissao para excluir essa midia.");
  }

  private async countActiveReferences(fileKey: string): Promise<number> {
    const [avatarRef, bannerRef, fileRefs, originalRefs, thumbRefs] = await Promise.all([
      this.options.adminSupabase.from("profiles").select("id").eq("avatar_key", fileKey).limit(1),
      this.options.adminSupabase.from("profiles").select("id").eq("banner_key", fileKey).limit(1),
      this.options.adminSupabase.from("attachments").select("message_id").eq("file_key", fileKey),
      this.options.adminSupabase.from("attachments").select("message_id").eq("original_key", fileKey),
      this.options.adminSupabase.from("attachments").select("message_id").eq("thumb_key", fileKey),
    ]);

    let referenceCount = 0;
    if (!avatarRef.error && (avatarRef.data?.length ?? 0) > 0) {
      referenceCount += 1;
    }
    if (!bannerRef.error && (bannerRef.data?.length ?? 0) > 0) {
      referenceCount += 1;
    }

    const messageIds = new Set<string>();
    [fileRefs, originalRefs, thumbRefs].forEach((result) => {
      if (result.error) {
        return;
      }
      for (const row of result.data ?? []) {
        const messageId = String((row as { message_id?: string }).message_id ?? "").trim();
        if (messageId) {
          messageIds.add(messageId);
        }
      }
    });

    if (messageIds.size > 0) {
      const { data, error } = await this.options.adminSupabase
        .from("messages")
        .select("id")
        .in("id", [...messageIds])
        .is("deleted_at", null);

      if (!error) {
        referenceCount += data?.length ?? 0;
      }
    }

    return referenceCount;
  }

  private async collectReferencedKeys(): Promise<Set<string>> {
    const keys = new Set<string>();

    await this.collectProfileKeys(keys);
    await this.collectActiveAttachmentKeys(keys);

    return keys;
  }

  private async collectProfileKeys(target: Set<string>): Promise<void> {
    let from = 0;
    const pageSize = 500;

    for (;;) {
      const { data, error } = await this.options.adminSupabase
        .from("profiles")
        .select("avatar_key,banner_key")
        .range(from, from + pageSize - 1);

      if (error || !data || data.length === 0) {
        return;
      }

      for (const row of data) {
        const avatarKey = String((row as { avatar_key?: string | null }).avatar_key ?? "").trim();
        const bannerKey = String((row as { banner_key?: string | null }).banner_key ?? "").trim();
        if (avatarKey) {
          target.add(avatarKey);
        }
        if (bannerKey) {
          target.add(bannerKey);
        }
      }

      if (data.length < pageSize) {
        return;
      }
      from += pageSize;
    }
  }

  private async collectActiveAttachmentKeys(target: Set<string>): Promise<void> {
    let from = 0;
    const pageSize = 500;

    for (;;) {
      const messagePage = await this.options.adminSupabase
        .from("messages")
        .select("id")
        .is("deleted_at", null)
        .range(from, from + pageSize - 1);

      if (messagePage.error || !messagePage.data || messagePage.data.length === 0) {
        return;
      }

      const messageIds = messagePage.data
        .map((row) => String((row as { id?: string }).id ?? "").trim())
        .filter(Boolean);

      if (messageIds.length > 0) {
        const attachmentPage = await this.options.adminSupabase
          .from("attachments")
          .select("file_key,original_key,thumb_key")
          .in("message_id", messageIds);

        if (!attachmentPage.error) {
          for (const row of attachmentPage.data ?? []) {
            const fileKey = String((row as { file_key?: string | null }).file_key ?? "").trim();
            const originalKey = String((row as { original_key?: string | null }).original_key ?? "").trim();
            const thumbKey = String((row as { thumb_key?: string | null }).thumb_key ?? "").trim();
            if (fileKey) {
              target.add(fileKey);
            }
            if (originalKey) {
              target.add(originalKey);
            }
            if (thumbKey) {
              target.add(thumbKey);
            }
          }
        }
      }

      if (messagePage.data.length < pageSize) {
        return;
      }
      from += pageSize;
    }
  }

  private async markAuthorizationStatus(
    fileKey: string,
    userId: string | null,
    status: "pending" | "uploaded" | "attached" | "deleted",
  ): Promise<void> {
    let query = this.options.adminSupabase.from("media_uploads").update({
      status,
      updated_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    }).eq("file_key", fileKey);

    if (userId) {
      query = query.eq("owner_user_id", userId);
    }

    const { error } = await query;
    if (error) {
      if (this.isMissingMediaRegistryTableError(error)) {
        return;
      }
      this.options.logger?.warn("Falha ao atualizar status de media_uploads", {
        fileKey,
        userId,
        status,
        code: error.code,
        message: error.message,
      });
    }
  }

  private isMissingMediaRegistryTableError(error: unknown): boolean {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: string }).code ?? "").trim()
        : "";
    const details =
      typeof error === "object" && error !== null && "details" in error
        ? String((error as { details?: string | null }).details ?? "").toLowerCase()
        : "";
    const hint =
      typeof error === "object" && error !== null && "hint" in error
        ? String((error as { hint?: string | null }).hint ?? "").toLowerCase()
        : "";
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: string }).message ?? "").toLowerCase()
        : String(error ?? "").toLowerCase();

    return (
      code === "42P01" ||
      code === "PGRST205" ||
      (message.includes("media_uploads") && (message.includes("does not exist") || message.includes("schema cache"))) ||
      details.includes("media_uploads") ||
      hint.includes("media_uploads")
    );
  }

  private isMediaRegistryMissingError(error: unknown): boolean {
    return error instanceof MediaServiceError && error.code === "MEDIA_SCHEMA_MISSING";
  }
}
