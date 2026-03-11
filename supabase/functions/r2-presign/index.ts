/// <reference path="../_shared/edge-runtime.d.ts" />
import { z } from "npm:zod@3.25.76";
import { validateSupabaseToken } from "../_shared/auth.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import {
  assertMethod,
  createRequestContext,
  HttpError,
  isOptionsRequest,
  logStructured,
  parseJsonBody,
  responseError,
  responseJson,
  responseNoContent,
} from "../_shared/http.ts";
import {
  assertSafeUploadType,
  parseAttachmentConversationId,
  sanitizeContentType,
  sanitizeMediaKey,
} from "../_shared/mediaSecurity.ts";
import { assertConversationMembership, resolveUserId } from "../_shared/user.ts";

const DEFAULT_EXPIRES_SECONDS = 300;
const MIN_EXPIRES_SECONDS = 60;
const MAX_EXPIRES_SECONDS = 900;
const LARGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const SERVICE_NAME = "s3";
const ALGORITHM = "AWS4-HMAC-SHA256";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
const ROUTE = "r2-presign";

const payloadSchema = z
  .object({
    action: z.enum(["get", "put"]).default("put"),
    key: z.string().min(1).max(512),
    contentType: z.string().max(120).optional().nullable(),
    fileSize: z.number().int().min(1).max(200 * 1024 * 1024).optional().nullable(),
    expiresSeconds: z.number().int().min(MIN_EXPIRES_SECONDS).max(MAX_EXPIRES_SECONDS).optional(),
  })
  .strict();

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalizePath(pathname: string): string {
  if (!pathname) {
    return "/";
  }
  return pathname
    .split("/")
    .map((segment) => encodeRfc3986(segment))
    .join("/")
    .replace(/\/{2,}/g, "/");
}

function toAmzDate(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/\.\d{3}Z$/, "Z");
  const amzDate = iso.replace(/[:-]/g, "");
  return {
    amzDate,
    dateStamp: amzDate.slice(0, 8),
  };
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSha256(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

async function getSigningKey(secret: string, dateStamp: string, region: string): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(new TextEncoder().encode(`AWS4${secret}`), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, SERVICE_NAME);
  return hmacSha256(kService, "aws4_request");
}

function buildCanonicalQuery(params: Array<[string, string]>): string {
  const sorted = [...params].sort(([aKey, aVal], [bKey, bVal]) => {
    if (aKey === bKey) {
      return aVal.localeCompare(bVal);
    }
    return aKey.localeCompare(bKey);
  });

  return sorted
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join("&");
}

function normalizeExpiresSeconds(rawValue: unknown): number {
  const numericValue = Number(rawValue);
  if (!Number.isFinite(numericValue)) {
    return DEFAULT_EXPIRES_SECONDS;
  }
  const integerValue = Math.trunc(numericValue);
  return Math.max(MIN_EXPIRES_SECONDS, Math.min(MAX_EXPIRES_SECONDS, integerValue));
}

async function presignUrl(options: {
  method: "GET" | "PUT";
  url: URL;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  expiresSeconds: number;
}): Promise<string> {
  const now = new Date();
  const { amzDate, dateStamp } = toAmzDate(now);
  const credentialScope = `${dateStamp}/${options.region}/${SERVICE_NAME}/aws4_request`;

  const hostHeader = options.url.host;
  const signedHeaders = ["host"];
  const headers: Record<string, string> = {
    host: hostHeader,
  };

  const queryParams: Array<[string, string]> = [];
  options.url.searchParams.forEach((value, key) => {
    queryParams.push([key, value]);
  });

  queryParams.push(["X-Amz-Algorithm", ALGORITHM]);
  queryParams.push(["X-Amz-Credential", `${options.accessKeyId}/${credentialScope}`]);
  queryParams.push(["X-Amz-Date", amzDate]);
  queryParams.push(["X-Amz-Expires", String(options.expiresSeconds)]);
  queryParams.push(["X-Amz-SignedHeaders", signedHeaders.join(";")]);

  const canonicalUri = canonicalizePath(options.url.pathname);
  const canonicalQueryString = buildCanonicalQuery(queryParams);
  const canonicalHeaders = signedHeaders
    .slice()
    .sort()
    .map((name) => `${name}:${headers[name]}`)
    .join("\n");

  const canonicalRequest = [
    options.method,
    canonicalUri,
    canonicalQueryString,
    `${canonicalHeaders}\n`,
    signedHeaders.slice().sort().join(";"),
    UNSIGNED_PAYLOAD,
  ].join("\n");

  const stringToSign = [ALGORITHM, amzDate, credentialScope, await sha256Hex(canonicalRequest)].join("\n");
  const signingKey = await getSigningKey(options.secretAccessKey, dateStamp, options.region);
  const signatureBytes = await hmacSha256(signingKey, stringToSign);
  const signature = Array.from(new Uint8Array(signatureBytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  const finalQuery = `${canonicalQueryString}&X-Amz-Signature=${signature}`;
  return `${options.url.origin}${canonicalUri}?${finalQuery}`;
}

async function authorizeMediaKeyAccess(key: string, action: "get" | "put", userId: string): Promise<void> {
  if (key.startsWith("attachments/")) {
    const conversationId = parseAttachmentConversationId(key);
    if (!conversationId) {
      throw new HttpError(400, "INVALID_ATTACHMENT_KEY", "Chave de anexo invalida.");
    }

    await assertConversationMembership(conversationId, userId);
    return;
  }

  if (action === "put" && (key.startsWith("avatars/") || key.startsWith("banners/"))) {
    const ownerSegment = key.split("/").filter(Boolean)[1] ?? "";
    const ownerId = ownerSegment.replace(/\.[^./\\]+$/, "");
    if (!ownerSegment || (ownerSegment !== userId && ownerId !== userId)) {
      throw new HttpError(403, "FORBIDDEN", "Sem permissao para alterar essa midia de perfil.");
    }
  }
}

function getRequiredEnv(name: string): string {
  const value = (Deno.env.get(name) ?? "").trim();
  if (!value) {
    throw new HttpError(500, "SERVER_CONFIG_ERROR", `${name} nao configurada.`);
  }
  return value;
}

Deno.serve(async (request: Request) => {
  const context = createRequestContext(ROUTE);

  try {
    if (isOptionsRequest(request)) {
      return responseNoContent(request);
    }

    assertMethod(request, "POST");

    const auth = await validateSupabaseToken(request);
    context.uid = auth.uid;

    const rawPayload = await parseJsonBody<unknown>(request);
    const parsed = payloadSchema.safeParse(rawPayload);
    if (!parsed.success) {
      throw new HttpError(400, "INVALID_PAYLOAD", "Payload invalido para presign.", {
        issues: parsed.error.issues.map((issue: { path: PropertyKey[]; message: string; code: string }) => ({
          path: issue.path.join("."),
          message: issue.message,
          code: issue.code,
        })),
      });
    }

    const payload = parsed.data;
    context.action = payload.action;

    const safeKey = sanitizeMediaKey(payload.key);
    const contentType = sanitizeContentType(payload.contentType);
    const expiresSeconds = normalizeExpiresSeconds(payload.expiresSeconds ?? DEFAULT_EXPIRES_SECONDS);
    const userId = await resolveUserId(auth.uid, auth.email);

    await enforceRateLimit(`presign:${auth.uid}`, 20, 60_000, ROUTE, { action: payload.action });

    if (payload.action === "put") {
      await enforceRateLimit(`presign-put:${auth.uid}`, 40, 60_000, ROUTE, { action: payload.action });
      assertSafeUploadType(safeKey, contentType);

      if ((payload.fileSize ?? 0) >= LARGE_ATTACHMENT_BYTES) {
        await enforceRateLimit(`presign-large:${auth.uid}`, 1, 20_000, ROUTE, {
          action: payload.action,
          policy: "large-attachment-cooldown",
        });
      }
    }

    await authorizeMediaKeyAccess(safeKey, payload.action, userId);

    const endpoint = getRequiredEnv("R2_ENDPOINT");
    const bucket = getRequiredEnv("R2_BUCKET");
    const accessKeyId = getRequiredEnv("R2_ACCESS_KEY_ID");
    const secretAccessKey = getRequiredEnv("R2_SECRET_ACCESS_KEY");
    const region = (Deno.env.get("R2_REGION") ?? "auto").trim() || "auto";

    const base = endpoint.replace(/\/+$/, "");
    const objectUrl = new URL(`${base}/${bucket}/${safeKey}`);

    const signedUrl = await presignUrl({
      method: payload.action === "put" ? "PUT" : "GET",
      url: objectUrl,
      accessKeyId,
      secretAccessKey,
      region,
      expiresSeconds,
    });

    const responsePayload = {
      key: safeKey,
      action: payload.action,
      url: signedUrl,
      expiresIn: expiresSeconds,
      ...(payload.action === "put" ? { contentType } : {}),
    };

    logStructured("info", "r2_presign_success", context, {
      status: 200,
      key: safeKey,
      action: payload.action,
    });

    return responseJson(request, responsePayload, 200);
  } catch (error) {
    logStructured("error", "r2_presign_failure", context, {
      status: error instanceof HttpError ? error.status : 500,
      code: error instanceof HttpError ? error.code : "INTERNAL_ERROR",
      error: error instanceof Error ? error.message : String(error ?? "Unknown error"),
    });

    return responseError(request, context, error);
  }
});
