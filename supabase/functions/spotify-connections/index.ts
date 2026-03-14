/// <reference path="../_shared/edge-runtime.d.ts" />
import { z } from "npm:zod@3.25.76";
import { validateSupabaseToken } from "../_shared/auth.ts";
import { evaluateCorsRequest } from "../_shared/cors.ts";
import {
  createRequestContext,
  HttpError,
  isOptionsRequest,
  logStructured,
  parseJsonBody,
  responseJson,
  responseNoContent,
} from "../_shared/http.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import { extractClientIpFromRequest } from "../_shared/loginLocation.ts";
import { getSupabaseAdminClient } from "../_shared/supabaseAdmin.ts";
import { resolveUserId } from "../_shared/user.ts";

const ROUTE = "spotify-connections";
const MAX_JSON_BODY_BYTES = 12 * 1024;
const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_ME_URL = "https://api.spotify.com/v1/me";
const SPOTIFY_PLAYER_URL = "https://api.spotify.com/v1/me/player";
const SPOTIFY_DEFAULT_REDIRECT_URI = "https://messly.site/callback";
const SPOTIFY_DEFAULT_ACCOUNT_NAME = "Spotify";
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const STATE_TTL_MS = 10 * 60 * 1000;

const SPOTIFY_OAUTH_SCOPES = [
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-read-currently-playing",
] as const;

const payloadSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("begin_oauth"), clientContext: z.enum(["web", "desktop"]).optional() }).strict(),
  z.object({
    action: z.literal("complete_oauth"),
    code: z.string().trim().min(4).max(2048),
    state: z.string().trim().min(8).max(512),
    showOnProfile: z.boolean().optional(),
    showAsStatus: z.boolean().optional(),
  }).strict(),
  z.object({ action: z.literal("sync") }).strict(),
  z.object({ action: z.literal("disconnect") }).strict(),
  z.object({ action: z.literal("set_visibility"), showOnProfile: z.boolean().optional(), showAsStatus: z.boolean().optional() }).strict(),
]);

type RequestPayload = z.infer<typeof payloadSchema>;

type SpotifyTokenRow = {
  user_id: string;
  spotify_user_id: string;
  access_token: string;
  refresh_token: string;
  token_type: string | null;
  scope: string | null;
  expires_at: string;
  account_name: string | null;
  account_url: string | null;
  account_product: string | null;
  revoked_at: string | null;
};

type SpotifyConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

type TokenPayload = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function asText(value: unknown): string {
  return String(value ?? "").trim();
}

function toErrorKey(error: HttpError | null): string {
  if (!error) return "internal_error";
  if (error.status === 401 || error.code === "INVALID_TOKEN" || error.code === "UNAUTHENTICATED") return "unauthorized";
  if (error.status === 429) return "rate_limited";
  return asText(error.code || "internal_error").toLowerCase();
}

function responseSpotifyError(request: Request, requestId: string, error: unknown): Response {
  const normalized = error instanceof HttpError ? error : new HttpError(500, "INTERNAL_ERROR", "Erro interno.");
  return responseJson(request, {
    error: toErrorKey(error instanceof HttpError ? error : null),
    message: normalized.message,
    details: normalized.details,
    requestId,
  }, normalized.status);
}

function generateStateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((part) => part.toString(16).padStart(2, "0")).join("");
}

function parseRetryAfterMs(response: Response): number | undefined {
  const raw = asText(response.headers.get("retry-after"));
  if (!raw) return undefined;
  const asSeconds = Number(raw);
  if (Number.isFinite(asSeconds) && asSeconds > 0) return Math.max(1000, Math.round(asSeconds * 1000));
  const asDate = Date.parse(raw);
  if (!Number.isFinite(asDate)) return undefined;
  return Math.max(1000, asDate - Date.now());
}

function defaultDisconnectedConnection() {
  return {
    v: 1,
    provider: "spotify",
    authState: "detached",
    connected: false,
    accountName: "",
    accountId: "",
    accountUrl: "",
    accountProduct: "",
    showOnProfile: false,
    showAsStatus: false,
    playback: null,
    updatedAt: nowIso(),
  };
}

function normalizeVisibility(value: unknown): { showOnProfile: boolean; showAsStatus: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { showOnProfile: true, showAsStatus: true };
  }
  const source = value as Record<string, unknown>;
  return {
    showOnProfile: typeof source.showOnProfile === "boolean" ? source.showOnProfile : true,
    showAsStatus: typeof source.showAsStatus === "boolean" ? source.showAsStatus : true,
  };
}

function buildConnection(input: {
  accountName: string;
  accountId: string;
  accountUrl: string;
  accountProduct: string;
  showOnProfile: boolean;
  showAsStatus: boolean;
  playback: unknown;
  updatedAt?: string;
}) {
  return {
    v: 1,
    provider: "spotify",
    authState: "oauth",
    connected: true,
    accountName: asText(input.accountName) || SPOTIFY_DEFAULT_ACCOUNT_NAME,
    accountId: asText(input.accountId),
    accountUrl: asText(input.accountUrl),
    accountProduct: asText(input.accountProduct).toLowerCase(),
    showOnProfile: input.showOnProfile,
    showAsStatus: input.showAsStatus,
    playback: input.playback,
    updatedAt: input.updatedAt ?? nowIso(),
  };
}

function stripWrappedQuotes(value: string): string {
  const normalized = asText(value);
  if (!normalized) return "";

  const first = normalized.charAt(0);
  const last = normalized.charAt(normalized.length - 1);
  if (
    (first === "\"" && last === "\"") ||
    (first === "'" && last === "'") ||
    (first === "`" && last === "`")
  ) {
    return normalized.slice(1, -1).trim();
  }

  return normalized;
}

function normalizeCredentialFromEnv(rawValue: string, keys: string[]): string {
  let normalized = asText(rawValue);
  if (!normalized) return "";

  for (const key of keys) {
    const prefix = `${key}=`;
    if (normalized.toUpperCase().startsWith(prefix.toUpperCase())) {
      normalized = normalized.slice(prefix.length).trim();
      break;
    }
  }

  normalized = stripWrappedQuotes(normalized);
  return normalized.replace(/\s+/g, "");
}

function getConfig(): SpotifyConfig {
  const clientId = normalizeCredentialFromEnv(
    String(Deno.env.get("SPOTIFY_CLIENT_ID") ?? Deno.env.get("VITE_SPOTIFY_CLIENT_ID") ?? ""),
    ["SPOTIFY_CLIENT_ID", "VITE_SPOTIFY_CLIENT_ID"],
  );
  const clientSecret = normalizeCredentialFromEnv(
    String(Deno.env.get("SPOTIFY_CLIENT_SECRET") ?? Deno.env.get("VITE_SPOTIFY_CLIENT_SECRET") ?? ""),
    ["SPOTIFY_CLIENT_SECRET", "VITE_SPOTIFY_CLIENT_SECRET"],
  );
  const redirectRaw = stripWrappedQuotes(
    asText(Deno.env.get("SPOTIFY_REDIRECT_URI") ?? Deno.env.get("VITE_SPOTIFY_REDIRECT_URI") ?? SPOTIFY_DEFAULT_REDIRECT_URI),
  );

  if (!clientId) throw new HttpError(500, "SERVER_CONFIG_ERROR", "SPOTIFY_CLIENT_ID nao configurada.");
  if (!clientSecret) throw new HttpError(500, "SERVER_CONFIG_ERROR", "SPOTIFY_CLIENT_SECRET nao configurada.");
  if (clientId === clientSecret) {
    throw new HttpError(
      500,
      "SERVER_CONFIG_ERROR",
      "SPOTIFY_CLIENT_SECRET invalida: o valor nao pode ser igual ao SPOTIFY_CLIENT_ID.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(redirectRaw || SPOTIFY_DEFAULT_REDIRECT_URI);
  } catch {
    throw new HttpError(500, "SERVER_CONFIG_ERROR", "SPOTIFY_REDIRECT_URI invalida.");
  }
  if (parsed.protocol !== "https:") {
    throw new HttpError(500, "SERVER_CONFIG_ERROR", "SPOTIFY_REDIRECT_URI deve usar https.");
  }
  parsed.search = "";
  parsed.hash = "";

  return {
    clientId,
    clientSecret,
    redirectUri: parsed.toString().replace(/\/+$/, ""),
  };
}

async function readProfileConnection(userId: string): Promise<unknown> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.from("profiles").select("spotify_connection").eq("id", userId).limit(1).maybeSingle();
  if (error) throw new HttpError(500, "PROFILE_READ_FAILED", "Falha ao carregar conexao Spotify do perfil.");
  return (data as { spotify_connection?: unknown } | null)?.spotify_connection ?? null;
}

async function writeProfileConnection(userId: string, connection: unknown): Promise<void> {
  const admin = getSupabaseAdminClient();
  const { error } = await admin.from("profiles").update({ spotify_connection: connection }).eq("id", userId);
  if (error) throw new HttpError(500, "PROFILE_UPDATE_FAILED", "Falha ao atualizar conexao Spotify no perfil.");
}

async function fetchToken(body: URLSearchParams): Promise<TokenPayload> {
  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = (await response.json().catch(() => null)) as TokenPayload | null;
  if (!response.ok) {
    const spotifyError = asText(payload?.error).toLowerCase();
    const message = asText(payload?.error_description) || asText(payload?.error) || "Falha na autenticacao Spotify.";
    if (spotifyError === "invalid_client" || message.toLowerCase().includes("invalid client secret")) {
      throw new HttpError(
        500,
        "SPOTIFY_SERVER_CONFIG_INVALID",
        "Configuracao OAuth do Spotify invalida no servidor.",
      );
    }
    throw new HttpError(response.status >= 500 ? 502 : 400, "SPOTIFY_TOKEN_FAILED", message);
  }
  return payload ?? {};
}

async function fetchSpotifyMe(accessToken: string): Promise<{ accountName: string; accountId: string; accountUrl: string; accountProduct: string }> {
  const response = await fetch(SPOTIFY_ME_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    if (response.status === 401) throw new HttpError(401, "SPOTIFY_TOKEN_EXPIRED", "Token Spotify expirado.");
    if (response.status === 429) {
      throw new HttpError(429, "SPOTIFY_RATE_LIMITED", "Spotify limitou as requisicoes.", { retryAfterMs: parseRetryAfterMs(response) });
    }
    throw new HttpError(502, "SPOTIFY_PROFILE_FAILED", "Nao foi possivel obter perfil do Spotify.");
  }

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const accountId = asText(payload?.id);
  const accountName = asText(payload?.display_name) || accountId || SPOTIFY_DEFAULT_ACCOUNT_NAME;
  const externalUrls = payload?.external_urls as { spotify?: unknown } | undefined;
  const accountUrl = asText(externalUrls?.spotify) || (accountId ? `https://open.spotify.com/user/${encodeURIComponent(accountId)}` : "");
  const accountProduct = asText(payload?.product).toLowerCase();
  if (!accountId) throw new HttpError(502, "SPOTIFY_PROFILE_INVALID", "Spotify nao retornou o identificador da conta.");

  return { accountName, accountId, accountUrl, accountProduct };
}

async function fetchPlayback(accessToken: string, updatedAt: string): Promise<unknown> {
  const response = await fetch(SPOTIFY_PLAYER_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  if (response.status === 204) {
    return null;
  }

  if (!response.ok) {
    if (response.status === 401) throw new HttpError(401, "SPOTIFY_TOKEN_EXPIRED", "Token Spotify expirado.");
    if (response.status === 429) throw new HttpError(429, "SPOTIFY_RATE_LIMITED", "Spotify limitou as requisicoes.", { retryAfterMs: parseRetryAfterMs(response) });
    throw new HttpError(502, "SPOTIFY_PLAYBACK_FAILED", "Nao foi possivel obter playback do Spotify.");
  }

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const item = (payload?.item ?? null) as Record<string, unknown> | null;
  if (!item) return null;

  const trackTitle = asText(item.name);
  const artists = Array.isArray(item.artists) ? item.artists as Array<Record<string, unknown>> : [];
  const artistNames = artists.map((artist) => asText(artist.name)).filter(Boolean).join(", ");
  const durationMs = Number(item.duration_ms ?? 0);
  const progressMs = Number(payload?.progress_ms ?? 0);
  if (!trackTitle || !artistNames || !Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }

  const album = (item.album ?? null) as Record<string, unknown> | null;
  const images = Array.isArray(album?.images) ? album?.images as Array<Record<string, unknown>> : [];
  const external = (item.external_urls ?? null) as Record<string, unknown> | null;
  const device = (payload?.device ?? null) as Record<string, unknown> | null;
  const repeatRaw = asText(payload?.repeat_state);

  return {
    trackTitle,
    artistNames,
    coverUrl: asText(images[0]?.url),
    trackUrl: asText(external?.spotify),
    trackId: asText(item.id) || asText(item.uri),
    progressSeconds: Math.max(0, progressMs) / 1000,
    durationSeconds: Math.max(0, durationMs) / 1000,
    isPlaying: payload?.is_playing === true,
    deviceId: asText(device?.id),
    deviceName: asText(device?.name),
    shuffleEnabled: payload?.shuffle_state === true,
    repeatMode: repeatRaw === "track" || repeatRaw === "context" ? repeatRaw : "off",
    updatedAt,
  };
}

async function findToken(userId: string): Promise<SpotifyTokenRow | null> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("spotify_oauth_tokens")
    .select("user_id,spotify_user_id,access_token,refresh_token,token_type,scope,expires_at,account_name,account_url,account_product,revoked_at")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  if (error) throw new HttpError(500, "SPOTIFY_TOKEN_READ_FAILED", "Falha ao carregar token Spotify.");
  if (!data) return null;
  const row = data as SpotifyTokenRow;
  if (row.revoked_at) return null;
  return row;
}

async function upsertToken(userId: string, input: {
  spotifyUserId: string;
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  scope: string;
  expiresAt: string;
  accountName: string;
  accountUrl: string;
  accountProduct: string;
}): Promise<void> {
  const admin = getSupabaseAdminClient();
  const now = nowIso();

  const { error: revokeError } = await admin
    .from("spotify_oauth_tokens")
    .update({ revoked_at: now })
    .neq("user_id", userId)
    .eq("spotify_user_id", input.spotifyUserId)
    .is("revoked_at", null);
  if (revokeError) throw new HttpError(500, "SPOTIFY_TOKEN_REVOKE_FAILED", "Falha ao vincular conta Spotify.");

  const { error } = await admin.from("spotify_oauth_tokens").upsert({
    user_id: userId,
    spotify_user_id: input.spotifyUserId,
    access_token: input.accessToken,
    refresh_token: input.refreshToken,
    token_type: input.tokenType,
    scope: input.scope,
    expires_at: input.expiresAt,
    account_name: input.accountName,
    account_url: input.accountUrl,
    account_product: input.accountProduct,
    revoked_at: null,
    refreshed_at: now,
    connected_at: now,
  }, { onConflict: "user_id" });
  if (error) throw new HttpError(500, "SPOTIFY_TOKEN_SAVE_FAILED", "Falha ao salvar token Spotify.");
}

async function revokeToken(userId: string): Promise<void> {
  const admin = getSupabaseAdminClient();
  const { error } = await admin
    .from("spotify_oauth_tokens")
    .update({ revoked_at: nowIso() })
    .eq("user_id", userId)
    .is("revoked_at", null);
  if (error) throw new HttpError(500, "SPOTIFY_TOKEN_REVOKE_FAILED", "Falha ao revogar token Spotify.");
}

async function cleanupUserStates(userId: string): Promise<void> {
  const admin = getSupabaseAdminClient();
  const { error } = await admin.from("spotify_oauth_states").delete().eq("user_id", userId);
  if (error) throw new HttpError(500, "SPOTIFY_STATE_CLEANUP_FAILED", "Falha ao limpar estados OAuth.");
}

async function createState(userId: string, clientContext: "web" | "desktop" | null): Promise<{ state: string; expiresAt: string }> {
  const admin = getSupabaseAdminClient();
  const state = generateStateToken();
  const expiresAt = new Date(Date.now() + STATE_TTL_MS).toISOString();
  const now = nowIso();

  await admin
    .from("spotify_oauth_states")
    .delete()
    .eq("user_id", userId)
    .or(`expires_at.lt.${now},consumed_at.not.is.null`);

  const { error } = await admin.from("spotify_oauth_states").insert({
    state,
    user_id: userId,
    expires_at: expiresAt,
    consumed_at: null,
    client_context: clientContext,
  });
  if (error) throw new HttpError(500, "SPOTIFY_STATE_CREATE_FAILED", "Falha ao criar estado OAuth.");

  return { state, expiresAt };
}

async function consumeState(userId: string, state: string): Promise<void> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("spotify_oauth_states")
    .select("state,user_id,expires_at,consumed_at")
    .eq("state", state)
    .limit(1)
    .maybeSingle();

  if (error) throw new HttpError(500, "SPOTIFY_STATE_READ_FAILED", "Falha ao validar estado OAuth.");
  if (!data) throw new HttpError(400, "SPOTIFY_STATE_INVALID", "Estado OAuth invalido.");

  const owner = asText((data as { user_id?: unknown }).user_id);
  const consumedAt = asText((data as { consumed_at?: unknown }).consumed_at);
  const expiresAt = Date.parse(asText((data as { expires_at?: unknown }).expires_at));

  if (!owner || owner !== userId) throw new HttpError(403, "SPOTIFY_STATE_FORBIDDEN", "Estado OAuth nao pertence ao usuario autenticado.");
  if (consumedAt) throw new HttpError(400, "SPOTIFY_STATE_ALREADY_USED", "Estado OAuth ja utilizado.");
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new HttpError(400, "SPOTIFY_STATE_EXPIRED", "Estado OAuth expirado.");

  const { error: consumeError } = await admin
    .from("spotify_oauth_states")
    .update({ consumed_at: nowIso() })
    .eq("state", state)
    .eq("user_id", userId)
    .is("consumed_at", null);
  if (consumeError) throw new HttpError(500, "SPOTIFY_STATE_CONSUME_FAILED", "Falha ao consumir estado OAuth.");
}

function buildAuthorizeUrl(config: SpotifyConfig, state: string): string {
  const url = new URL(SPOTIFY_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", SPOTIFY_OAUTH_SCOPES.join(" "));
  return url.toString();
}

async function exchangeCode(config: SpotifyConfig, code: string): Promise<{ accessToken: string; refreshToken: string; tokenType: string; scope: string; expiresAt: string }> {
  const payload = await fetchToken(new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  }));

  const accessToken = asText(payload.access_token);
  const refreshToken = asText(payload.refresh_token);
  const expiresIn = Number(payload.expires_in ?? 3600);
  if (!accessToken || !refreshToken) throw new HttpError(502, "SPOTIFY_TOKEN_INVALID", "Spotify nao retornou tokens validos.");

  return {
    accessToken,
    refreshToken,
    tokenType: asText(payload.token_type) || "Bearer",
    scope: asText(payload.scope),
    expiresAt: new Date(Date.now() + Math.max(1, expiresIn) * 1000).toISOString(),
  };
}

async function refreshToken(config: SpotifyConfig, refreshTokenValue: string): Promise<{ accessToken: string; refreshToken: string; tokenType: string; scope: string; expiresAt: string }> {
  let payload: TokenPayload;
  try {
    payload = await fetchToken(new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshTokenValue,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }));
  } catch (error) {
    if (error instanceof HttpError) {
      throw new HttpError(401, "SPOTIFY_REFRESH_FAILED", error.message, error.details);
    }
    throw error;
  }

  const accessToken = asText(payload.access_token);
  if (!accessToken) throw new HttpError(401, "SPOTIFY_REFRESH_INVALID", "Spotify nao retornou access token.");

  return {
    accessToken,
    refreshToken: asText(payload.refresh_token) || refreshTokenValue,
    tokenType: asText(payload.token_type) || "Bearer",
    scope: asText(payload.scope),
    expiresAt: new Date(Date.now() + Math.max(1, Number(payload.expires_in ?? 3600)) * 1000).toISOString(),
  };
}

async function withFreshToken(config: SpotifyConfig, userId: string, tokenRow: SpotifyTokenRow): Promise<SpotifyTokenRow | null> {
  const expiresAt = Date.parse(asText(tokenRow.expires_at));
  if (Number.isFinite(expiresAt) && expiresAt > Date.now() + TOKEN_EXPIRY_SKEW_MS) {
    return tokenRow;
  }

  try {
    const refreshed = await refreshToken(config, asText(tokenRow.refresh_token));
    await upsertToken(userId, {
      spotifyUserId: asText(tokenRow.spotify_user_id),
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      tokenType: refreshed.tokenType,
      scope: refreshed.scope || asText(tokenRow.scope),
      expiresAt: refreshed.expiresAt,
      accountName: asText(tokenRow.account_name) || SPOTIFY_DEFAULT_ACCOUNT_NAME,
      accountUrl: asText(tokenRow.account_url),
      accountProduct: asText(tokenRow.account_product),
    });
    return await findToken(userId);
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      await revokeToken(userId);
      await writeProfileConnection(userId, null);
      return null;
    }
    throw error;
  }
}

function parsePayload(raw: unknown): RequestPayload {
  const parsed = payloadSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  throw new HttpError(400, "INVALID_PAYLOAD", "Payload invalido.", {
    issues: parsed.error.issues.map((issue: { path: string[]; code: string; message: string }) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    })),
  });
}

Deno.serve(async (request: Request) => {
  const context = createRequestContext(ROUTE, request);

  try {
    const cors = evaluateCorsRequest(request);
    if (isOptionsRequest(request)) {
      return responseNoContent(request);
    }

    if (!cors.isAllowed) {
      throw new HttpError(403, "CORS_FORBIDDEN", "Origin nao permitida.");
    }

    if (request.method.toUpperCase() !== "POST") {
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Metodo nao permitido.");
    }

    const auth = await validateSupabaseToken(request);
    const userId = await resolveUserId(auth.uid);
    const payload = parsePayload(await parseJsonBody<unknown>(request, MAX_JSON_BODY_BYTES));
    context.uid = auth.uid;
    context.action = payload.action;

    const ip = extractClientIpFromRequest(request);
    await enforceRateLimit(`${ROUTE}:ip:${ip}`, 240, 60_000, ROUTE, { action: payload.action });
    await enforceRateLimit(`${ROUTE}:uid:${auth.uid}`, 120, 60_000, ROUTE, { action: payload.action });

    const config = getConfig();
    let responsePayload: Record<string, unknown> = {};

    if (payload.action === "begin_oauth") {
      const state = await createState(userId, payload.clientContext ?? null);
      responsePayload = {
        authorizeUrl: buildAuthorizeUrl(config, state.state),
        state: state.state,
        redirectUri: config.redirectUri,
        expiresAt: state.expiresAt,
      };
    } else if (payload.action === "complete_oauth") {
      await consumeState(userId, payload.state);
      const token = await exchangeCode(config, payload.code);
      const me = await fetchSpotifyMe(token.accessToken);
      const existingVisibility = normalizeVisibility(await readProfileConnection(userId));

      const showOnProfile = typeof payload.showOnProfile === "boolean" ? payload.showOnProfile : existingVisibility.showOnProfile;
      const showAsStatus = typeof payload.showAsStatus === "boolean" ? payload.showAsStatus : existingVisibility.showAsStatus;

      await upsertToken(userId, {
        spotifyUserId: me.accountId,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        tokenType: token.tokenType,
        scope: token.scope,
        expiresAt: token.expiresAt,
        accountName: me.accountName,
        accountUrl: me.accountUrl,
        accountProduct: me.accountProduct,
      });

      const connection = buildConnection({
        accountName: me.accountName,
        accountId: me.accountId,
        accountUrl: me.accountUrl,
        accountProduct: me.accountProduct,
        showOnProfile,
        showAsStatus,
        playback: null,
      });
      await writeProfileConnection(userId, connection);
      responsePayload = { connection };
    } else if (payload.action === "sync") {
      let tokenRow = await findToken(userId);
      if (!tokenRow) {
        await writeProfileConnection(userId, null);
        responsePayload = { connection: defaultDisconnectedConnection() };
      } else {
        tokenRow = await withFreshToken(config, userId, tokenRow);
        if (!tokenRow) {
          responsePayload = { connection: defaultDisconnectedConnection() };
        } else {
          let accessToken = asText(tokenRow.access_token);
          let updatedAt = nowIso();
          let playback: unknown = null;

          try {
            playback = await fetchPlayback(accessToken, updatedAt);
          } catch (error) {
            if (error instanceof HttpError && error.status === 401) {
              try {
                const refreshed = await refreshToken(config, asText(tokenRow.refresh_token));
                await upsertToken(userId, {
                  spotifyUserId: asText(tokenRow.spotify_user_id),
                  accessToken: refreshed.accessToken,
                  refreshToken: refreshed.refreshToken,
                  tokenType: refreshed.tokenType,
                  scope: refreshed.scope || asText(tokenRow.scope),
                  expiresAt: refreshed.expiresAt,
                  accountName: asText(tokenRow.account_name) || SPOTIFY_DEFAULT_ACCOUNT_NAME,
                  accountUrl: asText(tokenRow.account_url),
                  accountProduct: asText(tokenRow.account_product),
                });
              } catch (refreshError) {
                if (refreshError instanceof HttpError && refreshError.status === 401) {
                  await revokeToken(userId);
                  await writeProfileConnection(userId, null);
                  responsePayload = { connection: defaultDisconnectedConnection() };
                } else {
                  throw refreshError;
                }
              }

              const latest = await findToken(userId);
              if (!latest) {
                await writeProfileConnection(userId, null);
                responsePayload = { connection: defaultDisconnectedConnection() };
              } else {
                tokenRow = latest;
                accessToken = asText(latest.access_token);
                updatedAt = nowIso();
                playback = await fetchPlayback(accessToken, updatedAt);
              }
            } else {
              throw error;
            }
          }

          if (!responsePayload.connection) {
            let accountName = asText(tokenRow.account_name) || SPOTIFY_DEFAULT_ACCOUNT_NAME;
            let accountId = asText(tokenRow.spotify_user_id);
            let accountUrl = asText(tokenRow.account_url);
            let accountProduct = asText(tokenRow.account_product).toLowerCase();

            if (!accountId || !accountName) {
              const me = await fetchSpotifyMe(accessToken);
              accountName = me.accountName;
              accountId = me.accountId;
              accountUrl = me.accountUrl;
              accountProduct = me.accountProduct;
            }

            const visibility = normalizeVisibility(await readProfileConnection(userId));
            const connection = buildConnection({
              accountName,
              accountId,
              accountUrl,
              accountProduct,
              showOnProfile: visibility.showOnProfile,
              showAsStatus: visibility.showAsStatus,
              playback,
              updatedAt,
            });
            await writeProfileConnection(userId, connection);
            responsePayload = { connection };
          }
        }
      }
    } else if (payload.action === "disconnect") {
      await revokeToken(userId);
      await cleanupUserStates(userId);
      await writeProfileConnection(userId, null);
      responsePayload = { connection: defaultDisconnectedConnection() };
    } else {
      const hasShowOnProfile = typeof payload.showOnProfile === "boolean";
      const hasShowAsStatus = typeof payload.showAsStatus === "boolean";
      if (!hasShowOnProfile && !hasShowAsStatus) {
        throw new HttpError(400, "INVALID_PAYLOAD", "Informe showOnProfile ou showAsStatus.");
      }

      const tokenRow = await findToken(userId);
      const existingRaw = await readProfileConnection(userId);
      const visibility = normalizeVisibility(existingRaw);

      let accountName = asText((existingRaw as { accountName?: unknown } | null)?.accountName);
      let accountId = asText((existingRaw as { accountId?: unknown } | null)?.accountId);
      let accountUrl = asText((existingRaw as { accountUrl?: unknown } | null)?.accountUrl);
      let accountProduct = asText((existingRaw as { accountProduct?: unknown } | null)?.accountProduct);
      const playback = (existingRaw && typeof existingRaw === "object" && !Array.isArray(existingRaw))
        ? ((existingRaw as { playback?: unknown }).playback ?? null)
        : null;

      if ((!accountId || !accountName) && tokenRow) {
        accountName = asText(tokenRow.account_name) || SPOTIFY_DEFAULT_ACCOUNT_NAME;
        accountId = asText(tokenRow.spotify_user_id);
        accountUrl = asText(tokenRow.account_url);
        accountProduct = asText(tokenRow.account_product);
      }

      if (!accountId) {
        responsePayload = { connection: defaultDisconnectedConnection() };
      } else {
        const connection = buildConnection({
          accountName,
          accountId,
          accountUrl,
          accountProduct,
          showOnProfile: hasShowOnProfile ? Boolean(payload.showOnProfile) : visibility.showOnProfile,
          showAsStatus: hasShowAsStatus ? Boolean(payload.showAsStatus) : visibility.showAsStatus,
          playback,
        });
        await writeProfileConnection(userId, connection);
        responsePayload = { connection };
      }
    }

    logStructured("info", "spotify_connections_success", context, {
      status: 200,
      action: payload.action,
    });

    return responseJson(request, {
      ...responsePayload,
      serverTime: nowIso(),
    }, 200);
  } catch (error) {
    logStructured("error", "spotify_connections_failure", context, {
      status: error instanceof HttpError ? error.status : 500,
      code: error instanceof HttpError ? error.code : "INTERNAL_ERROR",
      error: error instanceof Error ? error.message : String(error ?? "Unknown error"),
    });
    return responseSpotifyError(request, context.requestId, error);
  }
});
