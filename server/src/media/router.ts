import { z } from "zod";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readAuthRequestContext, type AuthDependencies } from "../auth/types";
import { AuthHttpError, readJsonBody, resolveCorsHeaders, writeEmpty, writeJson } from "../auth/http";
import {
  MediaService,
  MediaServiceError,
  type CreateUploadInput,
  type DeleteMediaInput,
  type ProxyUploadInput,
  type UploadProfileMediaInput,
} from "./service";

const PUBLIC_MEDIA_READ_LIMIT = 100;
const PUBLIC_MEDIA_READ_WINDOW_MS = 60_000;

const createUploadSchema = z.object({
  kind: z.enum([
    "avatar",
    "banner",
    "message_image",
    "message_image_preview",
    "message_image_original",
    "message_video",
    "message_video_preview",
    "message_video_thumb",
    "message_file",
  ]),
  sha256: z.string().min(64).max(64),
  contentType: z.string().min(1).max(120),
  sizeBytes: z.number().int().positive().max(100 * 1024 * 1024),
  fileName: z.string().max(200).optional().nullable(),
  conversationId: z.string().uuid().optional().nullable(),
});

const deleteMediaSchema = z.object({
  fileKey: z.string().min(1).max(512),
});

function buildNotFoundBody() {
  return {
    error: {
      code: "NOT_FOUND",
      message: "Media endpoint not found.",
    },
  };
}

function normalizeMediaPath(pathnameRaw: string): string {
  const pathname = String(pathnameRaw ?? "").trim() || "/";
  if (pathname === "/api/media" || pathname.startsWith("/api/media/")) {
    return pathname.slice(4) || "/media";
  }
  return pathname;
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export class MediaRouter {
  private readonly mediaService: MediaService;
  private readonly publicMediaAllowedHosts: Set<string>;

  constructor(private readonly deps: Pick<AuthDependencies, "adminSupabase" | "sessionManager" | "rateLimiter" | "env" | "logger">) {
    this.mediaService = new MediaService({
      adminSupabase: deps.adminSupabase,
      sessionManager: deps.sessionManager,
      rateLimiter: deps.rateLimiter,
      env: deps.env,
      logger: deps.logger,
    });
    this.publicMediaAllowedHosts = this.buildPublicMediaAllowedHosts();
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://messly.local");
    const requestPath = normalizeMediaPath(url.pathname);
    if (!requestPath.startsWith("/media")) {
      return false;
    }

    const context = readAuthRequestContext(request);
    try {
      const corsHeaders = {
        ...resolveCorsHeaders(context.origin, this.deps.env),
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      };

      if (request.method === "OPTIONS") {
        writeEmpty(response, 204, {
          ...corsHeaders,
          "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        });
        return true;
      }

      if (request.method === "GET" && requestPath.startsWith("/media/public/")) {
        await this.enforcePublicReadRateLimit(context.ipAddress);
        this.assertPublicReadHotlinkHeaders(request);
        const fileKey = decodeURIComponent(requestPath.slice("/media/public/".length));
        const location = await this.mediaService.getPublicReadUrl(fileKey);
        response.writeHead(302, {
          location,
          "cache-control": "no-store",
          ...corsHeaders,
        });
        response.end();
        return true;
      }

      if (request.method === "POST" && requestPath === "/media/create-upload") {
        const body = createUploadSchema.parse(await readJsonBody<CreateUploadInput>(request));
        const payload = await this.mediaService.createUpload(
          context.authorizationToken ?? "",
          body,
          context.ipAddress,
        );
        writeJson(response, 200, payload, corsHeaders);
        return true;
      }

      if (request.method === "POST" && requestPath === "/media/upload/profile") {
        const kind = String(url.searchParams.get("kind") ?? "").trim().toLowerCase();
        if (kind !== "avatar" && kind !== "banner") {
          throw new AuthHttpError(400, "INVALID_MEDIA_KIND", "kind deve ser avatar ou banner.");
        }
        const fileName = String(url.searchParams.get("fileName") ?? "").trim() || null;
        const contentType = String(request.headers["content-type"] ?? "").trim().toLowerCase();
        const body = await readRawBody(request);
        const payload = await this.mediaService.uploadProfileMedia(
          context.authorizationToken ?? "",
          {
            kind,
            fileName,
            contentType,
            body,
          } satisfies UploadProfileMediaInput,
          context.ipAddress,
        );
        writeJson(response, 200, payload, corsHeaders);
        return true;
      }

      if (request.method === "POST" && requestPath === "/media/upload-proxy") {
        const fileKey = String(url.searchParams.get("fileKey") ?? "").trim();
        const contentType = String(request.headers["content-type"] ?? "").trim().toLowerCase();
        const body = await readRawBody(request);
        const payload = await this.mediaService.proxyUpload(
          context.authorizationToken ?? "",
          {
            fileKey,
            contentType,
            body,
          } satisfies ProxyUploadInput,
          context.ipAddress,
        );
        writeJson(response, 200, payload, corsHeaders);
        return true;
      }

      if (request.method === "DELETE" && requestPath === "/media") {
        const body = deleteMediaSchema.parse(await readJsonBody<DeleteMediaInput>(request));
        const payload = await this.mediaService.deleteMedia(context.authorizationToken ?? "", body);
        writeJson(response, 200, payload, corsHeaders);
        return true;
      }

      writeJson(response, 404, buildNotFoundBody(), corsHeaders);
      return true;
    } catch (error) {
      const httpError = this.toHttpError(error);
      let corsHeaders: Record<string, string>;
      try {
        corsHeaders = {
          ...resolveCorsHeaders(context.origin, this.deps.env),
          "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        };
      } catch {
        corsHeaders = {
          vary: "Origin",
        };
      }

      this.deps.logger?.warn("Media request failed", {
        path: url.pathname,
        method: request.method,
        code: httpError.code,
        status: httpError.status,
        message: httpError.message,
      });

      writeJson(
        response,
        httpError.status,
        {
          error: {
            code: httpError.code,
            message: httpError.message,
            details: httpError.details,
          },
        },
        corsHeaders,
        httpError.headers,
      );
      return true;
    }
  }

  private toHttpError(error: unknown): AuthHttpError {
    if (error instanceof AuthHttpError) {
      return error;
    }

    if (error instanceof MediaServiceError) {
      return new AuthHttpError(error.status, error.code, error.message, error.details, error.headers);
    }

    if (error instanceof z.ZodError) {
      return new AuthHttpError(400, "INVALID_MEDIA_PAYLOAD", "Payload de midia invalido.", {
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
          code: issue.code,
        })),
      });
    }

    return new AuthHttpError(
      500,
      "MEDIA_INTERNAL_ERROR",
      error instanceof Error ? error.message : "Unexpected media server error.",
    );
  }

  private buildPublicMediaAllowedHosts(): Set<string> {
    const allowed = new Set<string>([
      "messly.site",
      "www.messly.site",
      "cdn.messly.site",
      "gateway.messly.site",
      "localhost",
      "127.0.0.1",
      "::1",
    ]);
    for (const origin of this.deps.env.allowedOrigins) {
      try {
        const parsed = new URL(origin);
        allowed.add(parsed.hostname.toLowerCase());
      } catch {
        // Ignore invalid origin entries.
      }
    }
    return allowed;
  }

  private parseHeaderHost(valueRaw: string | null | undefined): string | null {
    const value = String(valueRaw ?? "").trim();
    if (!value || value.toLowerCase() === "null") {
      return null;
    }
    try {
      const parsed = new URL(value);
      return parsed.hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  private assertPublicReadHotlinkHeaders(request: IncomingMessage): void {
    const originRaw = String(request.headers.origin ?? "").trim();
    const refererRaw = String(request.headers.referer ?? request.headers.referrer ?? "").trim();

    const originHost = this.parseHeaderHost(originRaw);
    if (originRaw && !originHost) {
      throw new AuthHttpError(403, "HOTLINK_FORBIDDEN", "Origem de midia invalida.");
    }
    if (originHost && !this.publicMediaAllowedHosts.has(originHost)) {
      throw new AuthHttpError(403, "HOTLINK_FORBIDDEN", "Origem nao autorizada para consumo de midia.");
    }

    const refererHost = this.parseHeaderHost(refererRaw);
    if (refererRaw && !refererHost) {
      throw new AuthHttpError(403, "HOTLINK_FORBIDDEN", "Referer de midia invalido.");
    }
    if (refererHost && !this.publicMediaAllowedHosts.has(refererHost)) {
      throw new AuthHttpError(403, "HOTLINK_FORBIDDEN", "Referer nao autorizado para consumo de midia.");
    }
  }

  private async enforcePublicReadRateLimit(ipAddress: string): Promise<void> {
    const outcome = await this.deps.rateLimiter.consume(
      `media:public-read:${String(ipAddress ?? "").trim() || "unknown"}`,
      PUBLIC_MEDIA_READ_LIMIT,
      PUBLIC_MEDIA_READ_WINDOW_MS,
    );
    if (outcome.allowed) {
      return;
    }
    const retryAfterSeconds = Math.max(1, Math.ceil(outcome.retryAfterMs / 1000));
    throw new AuthHttpError(
      429,
      "MEDIA_PUBLIC_RATE_LIMITED",
      "Muitas requisicoes de midia. Tente novamente em instantes.",
      {
        retry_after_ms: outcome.retryAfterMs,
        limit: PUBLIC_MEDIA_READ_LIMIT,
        window_ms: PUBLIC_MEDIA_READ_WINDOW_MS,
      },
      {
        "retry-after": String(retryAfterSeconds),
      },
    );
  }
}
