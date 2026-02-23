import { validateFirebaseToken } from "../_shared/auth.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import {
  assertMethod,
  createRequestContext,
  HttpError,
  isOptionsRequest,
  logStructured,
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
import { assertConversationMembership, resolveUserIdByFirebaseUid } from "../_shared/user.ts";

const DEFAULT_EXPIRES_SECONDS = 300;
const MIN_EXPIRES_SECONDS = 60;
const MAX_EXPIRES_SECONDS = 900;
const LARGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const SERVICE_NAME = "s3";
const ALGORITHM = "AWS4-HMAC-SHA256";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
const ROUTE = "r2-upload";

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

async function hmacSha256(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
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

async function presignUrl(options: {
  method: "PUT";
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

function getRequiredEnv(name: string): string {
  const value = (Deno.env.get(name) ?? "").trim();
  if (!value) {
    throw new HttpError(500, "SERVER_CONFIG_ERROR", `${name} nao configurada.`);
  }
  return value;
}

function normalizeExpiresSeconds(rawValue: unknown): number {
  const numericValue = Number(rawValue);
  if (!Number.isFinite(numericValue)) {
    return DEFAULT_EXPIRES_SECONDS;
  }

  const integerValue = Math.trunc(numericValue);
  return Math.max(MIN_EXPIRES_SECONDS, Math.min(MAX_EXPIRES_SECONDS, integerValue));
}

function parseContentLength(request: Request): number {
  const raw = request.headers.get("content-length");
  const parsed = Number(raw ?? NaN);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.trunc(parsed);
}

async function authorizeMediaKeyAccess(key: string, userId: string): Promise<void> {
  if (key.startsWith("attachments/")) {
    const conversationId = parseAttachmentConversationId(key);
    if (!conversationId) {
      throw new HttpError(400, "INVALID_ATTACHMENT_KEY", "Chave de anexo invalida.");
    }

    await assertConversationMembership(conversationId, userId);
    return;
  }

  if (key.startsWith("avatars/") || key.startsWith("banners/")) {
    const ownerSegment = key.split("/").filter(Boolean)[1] ?? "";
    if (!ownerSegment || ownerSegment !== userId) {
      throw new HttpError(403, "FORBIDDEN", "Sem permissao para alterar essa midia de perfil.");
    }
  }
}

Deno.serve(async (request) => {
  const context = createRequestContext(ROUTE);

  try {
    if (isOptionsRequest(request)) {
      return responseNoContent(request);
    }

    assertMethod(request, "POST");

    const auth = await validateFirebaseToken(request);
    context.uid = auth.uid;

    const safeKey = sanitizeMediaKey(request.headers.get("x-media-key"));
    const contentType = sanitizeContentType(request.headers.get("content-type"));
    const expiresSeconds = normalizeExpiresSeconds(request.headers.get("x-presign-expires"));
    const payloadSize = parseContentLength(request);

    assertSafeUploadType(safeKey, contentType);

    await enforceRateLimit(`upload:${auth.uid}`, 20, 60_000, ROUTE);

    if (payloadSize >= LARGE_ATTACHMENT_BYTES) {
      await enforceRateLimit(`upload-large:${auth.uid}`, 1, 20_000, ROUTE, {
        policy: "large-attachment-cooldown",
      });
    }

    const userId = await resolveUserIdByFirebaseUid(auth.uid, auth.email);
    await authorizeMediaKeyAccess(safeKey, userId);

    const endpoint = getRequiredEnv("R2_ENDPOINT");
    const bucket = getRequiredEnv("R2_BUCKET");
    const accessKeyId = getRequiredEnv("R2_ACCESS_KEY_ID");
    const secretAccessKey = getRequiredEnv("R2_SECRET_ACCESS_KEY");
    const region = (Deno.env.get("R2_REGION") ?? "auto").trim() || "auto";

    const objectUrl = new URL(`${endpoint.replace(/\/+$/, "")}/${bucket}/${safeKey}`);
    const signedUrl = await presignUrl({
      method: "PUT",
      url: objectUrl,
      accessKeyId,
      secretAccessKey,
      region,
      expiresSeconds,
    });

    const binaryBody = await request.arrayBuffer();
    const uploadResult = await fetch(signedUrl, {
      method: "PUT",
      headers: {
        "content-type": contentType,
      },
      body: binaryBody,
    });

    if (!uploadResult.ok) {
      throw new HttpError(502, "UPLOAD_FAILED", "Falha ao enviar arquivo para o storage.");
    }

    logStructured("info", "r2_upload_success", context, {
      status: 200,
      key: safeKey,
      bytes: binaryBody.byteLength,
    });

    return responseJson(
      request,
      {
        key: safeKey,
        contentType,
        size: binaryBody.byteLength,
      },
      200,
    );
  } catch (error) {
    logStructured("error", "r2_upload_failure", context, {
      status: error instanceof HttpError ? error.status : 500,
      code: error instanceof HttpError ? error.code : "INTERNAL_ERROR",
      error: error instanceof Error ? error.message : String(error ?? "Unknown error"),
    });

    return responseError(request, context, error);
  }
});
