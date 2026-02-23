import { HttpError } from "./http.ts";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "npm:jose@5.9.6";

export interface FirebaseAuthContext {
  uid: string;
  email: string | null;
  token: string;
  issuedAtSeconds: number | null;
  expiresAtSeconds: number | null;
}

interface FirebaseLookupUser {
  localId?: string;
  email?: string;
}

interface FirebaseLookupResponse {
  users?: FirebaseLookupUser[];
}

interface CachedTokenEntry {
  auth: FirebaseAuthContext;
  expiresAtMs: number;
}

const tokenCache = new Map<string, CachedTokenEntry>();
const FALLBACK_CACHE_TTL_MS = 30_000;
const FIREBASE_JWKS_URL = new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
const firebaseJwks = createRemoteJWKSet(FIREBASE_JWKS_URL);

function parseBearerToken(authHeader: string | null): string {
  if (!authHeader) {
    throw new HttpError(401, "UNAUTHENTICATED", "Token Firebase ausente.");
  }

  const trimmed = authHeader.trim();
  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (!match) {
    throw new HttpError(401, "UNAUTHENTICATED", "Header Authorization invalido.");
  }

  const token = match[1]?.trim();
  if (!token) {
    throw new HttpError(401, "UNAUTHENTICATED", "Token Firebase ausente.");
  }

  return token;
}

function resolveFirebaseAuthHeader(request: Request): string | null {
  const firebaseAuthHeader = request.headers.get("x-firebase-authorization");
  if (firebaseAuthHeader?.trim()) {
    return firebaseAuthHeader;
  }

  const clientInfoHeader = request.headers.get("x-client-info");
  if (/^Bearer\s+.+/i.test(String(clientInfoHeader ?? "").trim())) {
    return clientInfoHeader;
  }

  const requestedWithHeader = request.headers.get("x-requested-with");
  if (/^Bearer\s+.+/i.test(String(requestedWithHeader ?? "").trim())) {
    return requestedWithHeader;
  }

  return request.headers.get("authorization");
}

function decodeJwtPayload(token: string): { exp?: number; iat?: number } {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return {};
  }

  const payloadSegment = parts[1];
  if (!payloadSegment) {
    return {};
  }

  try {
    const normalized = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const paddingLength = (4 - (normalized.length % 4)) % 4;
    const padded = `${normalized}${"=".repeat(paddingLength)}`;
    const decoded = atob(padded);
    const parsed = JSON.parse(decoded) as { exp?: number; iat?: number };
    return parsed;
  } catch {
    return {};
  }
}

function getFirebaseProjectId(): string {
  const projectId =
    Deno.env.get("FIREBASE_PROJECT_ID") ??
    Deno.env.get("VITE_FIREBASE_PROJECT_ID") ??
    Deno.env.get("GCLOUD_PROJECT") ??
    "";

  return projectId.trim();
}

function getFirebaseApiKey(): string {
  const apiKey =
    Deno.env.get("FIREBASE_WEB_API_KEY") ??
    Deno.env.get("VITE_FIREBASE_API_KEY") ??
    Deno.env.get("FIREBASE_API_KEY") ??
    "";

  if (!apiKey.trim()) {
    throw new HttpError(500, "SERVER_CONFIG_ERROR", "FIREBASE_WEB_API_KEY nao configurada.");
  }

  return apiKey.trim();
}

async function lookupFirebaseToken(token: string): Promise<FirebaseLookupResponse> {
  const apiKey = getFirebaseApiKey();
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        idToken: token,
      }),
    },
  );

  if (!response.ok) {
    if (response.status >= 400 && response.status < 500) {
      throw new HttpError(401, "INVALID_TOKEN", "Token Firebase invalido ou expirado.");
    }
    throw new HttpError(502, "AUTH_PROVIDER_ERROR", "Falha ao validar token Firebase.");
  }

  try {
    return (await response.json()) as FirebaseLookupResponse;
  } catch {
    throw new HttpError(502, "AUTH_PROVIDER_ERROR", "Resposta invalida do provedor de autenticacao.");
  }
}

async function verifyFirebaseJwtLocally(token: string): Promise<{ uid: string; email: string | null; payload: JWTPayload }> {
  const projectId = getFirebaseProjectId();
  if (!projectId) {
    throw new Error("FIREBASE_PROJECT_ID_NOT_CONFIGURED");
  }

  const verified = await jwtVerify(token, firebaseJwks, {
    algorithms: ["RS256"],
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
  });

  const payload = verified.payload;
  const uid = String(payload.sub ?? payload.user_id ?? "").trim();
  if (!uid) {
    throw new HttpError(401, "INVALID_TOKEN", "Token Firebase sem uid valido.");
  }

  const email = typeof payload.email === "string" && payload.email.trim() ? payload.email.trim() : null;
  return {
    uid,
    email,
    payload,
  };
}

export async function validateFirebaseToken(request: Request): Promise<FirebaseAuthContext> {
  const token = parseBearerToken(resolveFirebaseAuthHeader(request));
  const cached = tokenCache.get(token);

  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.auth;
  }

  let resolvedUid = "";
  let resolvedEmail: string | null = null;
  let jwtPayload: { exp?: number; iat?: number } = decodeJwtPayload(token);

  try {
    const localVerification = await verifyFirebaseJwtLocally(token);
    resolvedUid = localVerification.uid;
    resolvedEmail = localVerification.email;
    jwtPayload = {
      exp: Number.isFinite(localVerification.payload.exp) ? Number(localVerification.payload.exp) : jwtPayload.exp,
      iat: Number.isFinite(localVerification.payload.iat) ? Number(localVerification.payload.iat) : jwtPayload.iat,
    };
  } catch (localError) {
    const fallbackAllowed =
      localError instanceof Error &&
      (localError.message === "FIREBASE_PROJECT_ID_NOT_CONFIGURED" ||
        localError.message.includes("JWKS") ||
        localError.message.includes("fetch") ||
        localError.message.includes("network"));

    if (!fallbackAllowed && localError instanceof HttpError) {
      throw localError;
    }

    const lookup = await lookupFirebaseToken(token);
    const user = lookup.users?.[0];
    const uid = String(user?.localId ?? "").trim();
    if (!uid) {
      throw new HttpError(401, "INVALID_TOKEN", "Token Firebase sem uid valido.");
    }
    resolvedUid = uid;
    resolvedEmail = user?.email ? String(user.email) : null;
  }

  if (!resolvedUid) {
    throw new HttpError(401, "INVALID_TOKEN", "Token Firebase sem uid valido.");
  }

  const nowMs = Date.now();
  const expiresAtMs = Number.isFinite(jwtPayload.exp)
    ? Math.max(nowMs + 1000, Number(jwtPayload.exp) * 1000)
    : nowMs + FALLBACK_CACHE_TTL_MS;

  const auth: FirebaseAuthContext = {
    uid: resolvedUid,
    email: resolvedEmail,
    token,
    issuedAtSeconds: Number.isFinite(jwtPayload.iat) ? Number(jwtPayload.iat) : null,
    expiresAtSeconds: Number.isFinite(jwtPayload.exp) ? Number(jwtPayload.exp) : null,
  };

  tokenCache.set(token, {
    auth,
    expiresAtMs,
  });

  return auth;
}
