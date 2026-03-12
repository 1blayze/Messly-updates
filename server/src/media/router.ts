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

  constructor(private readonly deps: Pick<AuthDependencies, "adminSupabase" | "sessionManager" | "rateLimiter" | "env" | "logger">) {
    this.mediaService = new MediaService({
      adminSupabase: deps.adminSupabase,
      sessionManager: deps.sessionManager,
      rateLimiter: deps.rateLimiter,
      env: deps.env,
      logger: deps.logger,
    });
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
          "access-control-allow-methods": "POST, DELETE, OPTIONS",
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
}
