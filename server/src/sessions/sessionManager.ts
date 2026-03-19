import type { SupabaseClient } from "@supabase/supabase-js";
import { decodeSupabaseJwtClaims, type SupabaseJwtClaims } from "../auth/jwtClaims";
import type { Logger } from "../infra/logger";
import { getLoginLocation } from "./loginLocation";

export interface SessionClientInfo {
  name?: string | null;
  version?: string | null;
  platform?: string | null;
  clientType?: string | null;
  deviceId?: string | null;
  userAgent?: string | null;
}

interface UserSessionRow {
  id: string;
  user_id: string;
  session_token: string;
  auth_session_id: string | null;
  device_id: string | null;
  client_type: string | null;
  platform: string | null;
  ip_address: string;
  city: string | null;
  region: string | null;
  country: string | null;
  location_label: string | null;
  device: string;
  os: string;
  app_version: string | null;
  client_version: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  ended_at: string | null;
  revoked_at: string | null;
  suspicious?: boolean | null;
}

export interface SessionView {
  id: string;
  recordId: string;
  deviceId: string;
  clientType: string;
  platform: string;
  device: string;
  os: string;
  appVersion: string | null;
  clientVersion: string | null;
  location: string | null;
  ipAddressMasked: string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  userAgent: string | null;
  suspicious: boolean;
}

export interface UpsertSessionInput {
  accessToken: string;
  userId: string;
  ipAddress: string;
  userAgent: string | null;
  client: SessionClientInfo | null;
}

function normalizeText(value: unknown, maxLength: number): string | null {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maxLength);
  return normalized || null;
}

function normalizeSessionKey(value: unknown): string | null {
  const normalized = normalizeText(value, 64);
  return normalized || null;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeClientType(client: SessionClientInfo | null): string {
  const explicit = String(client?.clientType ?? "").trim().toLowerCase();
  if (explicit === "desktop" || explicit === "web" || explicit === "mobile") {
    return explicit;
  }

  const platform = normalizePlatform(client);
  if (platform === "windows" || platform === "macos" || platform === "linux") {
    return "desktop";
  }
  if (platform === "android" || platform === "ios") {
    return "mobile";
  }
  if (platform === "browser") {
    return "web";
  }
  return "unknown";
}

function normalizePlatform(client: SessionClientInfo | null): string {
  const platform = String(client?.platform ?? "").trim().toLowerCase();
  switch (platform) {
    case "win32":
    case "windows":
      return "windows";
    case "darwin":
    case "mac":
    case "macos":
      return "macos";
    case "linux":
      return "linux";
    case "web":
    case "browser":
      return "browser";
    case "android":
      return "android";
    case "ios":
    case "iphone":
    case "ipad":
      return "ios";
    default:
      return platform || "unknown";
  }
}

function buildDeviceId(client: SessionClientInfo | null, rowIdFallback: string): string {
  const explicit = normalizeText(client?.deviceId, 128);
  return explicit ?? `legacy:${rowIdFallback}`;
}

function buildClientName(client: SessionClientInfo | null): string {
  const explicit = normalizeText(client?.name, 80);
  if (explicit) {
    return explicit;
  }

  return normalizeClientType(client) === "desktop" ? "Azyoon Desktop" : "Azyoon";
}

function detectOsFromUserAgent(userAgentRaw: string | null): string | null {
  const userAgent = String(userAgentRaw ?? "").trim().toLowerCase();
  if (!userAgent) {
    return null;
  }

  if (userAgent.includes("android")) {
    return "Android";
  }
  if (userAgent.includes("iphone") || userAgent.includes("ipod")) {
    return "iOS";
  }
  if (userAgent.includes("ipad")) {
    return "iPadOS";
  }
  if (userAgent.includes("windows nt")) {
    return "Windows";
  }
  if (userAgent.includes("mac os x") || userAgent.includes("macintosh")) {
    return "macOS";
  }
  if (userAgent.includes("linux")) {
    return "Linux";
  }
  return null;
}

function buildOsLabel(client: SessionClientInfo | null, userAgent: string | null): string {
  const platform = normalizePlatform(client);
  switch (platform) {
    case "windows":
      return "Windows";
    case "macos":
      return "macOS";
    case "linux":
      return "Linux";
    case "android":
      return "Android";
    case "ios":
      return "iOS";
    default:
      return detectOsFromUserAgent(userAgent) ?? "Sistema";
  }
}

function maskIpAddress(ipAddressRaw: string): string {
  const ipAddress = String(ipAddressRaw ?? "").trim();
  if (!ipAddress) {
    return "0.0.0.0";
  }

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ipAddress)) {
    const [first] = ipAddress.split(".");
    return `${first ?? "0"}.xxx.xxx.xxx`;
  }

  const parts = ipAddress.split(":");
  return `${parts.slice(0, 2).join(":") || "xxxx"}:xxxx:xxxx:xxxx:xxxx`;
}

function toLocation(row: UserSessionRow): string | null {
  const explicit = normalizeText(row.location_label, 240);
  if (explicit) {
    return explicit;
  }

  const parts = [row.city, row.region, row.country]
    .map((value) => normalizeText(value, 120))
    .filter((value, index, array): value is string => Boolean(value) && array.indexOf(value) === index);

  return parts.length > 0 ? parts.join(", ") : null;
}

function toSessionView(row: UserSessionRow): SessionView {
  return {
    id: row.auth_session_id ?? row.id,
    recordId: row.id,
    deviceId: normalizeText(row.device_id, 128) ?? `legacy:${row.id}`,
    clientType: normalizeText(row.client_type, 32) ?? "unknown",
    platform: normalizeText(row.platform, 32) ?? "unknown",
    device: row.device,
    os: row.os,
    appVersion: normalizeText(row.app_version, 32),
    clientVersion: normalizeText(row.client_version, 32),
    location: toLocation(row),
    ipAddressMasked: maskIpAddress(row.ip_address),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at ?? row.ended_at ?? null,
    userAgent: normalizeText(row.user_agent, 512),
    suspicious: Boolean(row.suspicious),
  };
}

function buildRegistrationPayload(
  sessionKey: string,
  input: UpsertSessionInput,
  location: Awaited<ReturnType<typeof getLoginLocation>>,
  nowIso: string,
  rowIdFallback: string,
): Record<string, string | null> {
  const clientVersion = normalizeText(input.client?.version, 32);
  return {
    user_id: input.userId,
    session_token: sessionKey,
    auth_session_id: sessionKey,
    device_id: buildDeviceId(input.client, rowIdFallback),
    client_type: normalizeClientType(input.client),
    platform: normalizePlatform(input.client),
    ip_address: normalizeText(input.ipAddress, 120) ?? location.ip,
    city: normalizeText(location.city, 120),
    region: normalizeText(location.region, 120),
    country: normalizeText(location.country, 120),
    location_label: normalizeText(location.locationLabel, 240),
    device: buildClientName(input.client),
    os: buildOsLabel(input.client, input.userAgent),
    app_version: clientVersion,
    client_version: clientVersion,
    user_agent: normalizeText(input.userAgent, 512),
    last_seen_at: nowIso,
    ended_at: null,
    revoked_at: null,
  };
}

export class AuthSessionManager {
  private readonly lastTouchByAuthSessionId = new Map<string, number>();

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly logger?: Logger,
    private readonly minTouchIntervalMs = 60_000,
  ) {}

  private async resolveValidatedClaims(
    accessTokenRaw: string,
    expectedUserIdRaw?: string | null,
  ): Promise<SupabaseJwtClaims & { sessionId: string }> {
    const accessToken = String(accessTokenRaw ?? "").trim();
    if (!accessToken) {
      throw new Error("Missing Supabase access token.");
    }

    const expectedUserId = String(expectedUserIdRaw ?? "").trim();
    const authResult = await this.supabase.auth.getUser(accessToken);
    const tokenUserId = String(authResult.data.user?.id ?? "").trim();
    if (authResult.error || !tokenUserId) {
      throw new Error("Invalid Supabase access token.");
    }

    if (expectedUserId && expectedUserId !== tokenUserId) {
      throw new Error("Supabase access token user mismatch.");
    }

    const claims = decodeSupabaseJwtClaims(accessToken);
    if (!claims?.sessionId || !claims.userId) {
      throw new Error("Invalid Supabase session claims.");
    }

    if (claims.userId !== tokenUserId) {
      throw new Error("Supabase token subject mismatch.");
    }

    if (claims.expiresAt && claims.expiresAt * 1000 <= Date.now()) {
      throw new Error("Supabase access token is expired.");
    }

    return {
      ...claims,
      sessionId: claims.sessionId,
    };
  }

  async upsertFromAccessToken(input: UpsertSessionInput): Promise<SessionView> {
    const claims = await this.resolveValidatedClaims(input.accessToken, input.userId);

    const sessionKey = normalizeSessionKey(claims.sessionId);
    if (!sessionKey) {
      throw new Error("Missing auth session identifier.");
    }

    const existing = await this.findByAuthSessionId(sessionKey);
    if (existing && (existing.ended_at || existing.revoked_at)) {
      throw new Error("Auth session is no longer active.");
    }

    const nowIso = new Date().toISOString();
    const location = await getLoginLocation(normalizeText(input.ipAddress, 120) ?? "0.0.0.0");
    const payload = buildRegistrationPayload(sessionKey, input, location, nowIso, existing?.id ?? sessionKey);

    if (existing) {
      const { data, error } = await this.supabase
        .from("user_sessions")
        .update(payload)
        .eq("id", existing.id)
        .select("*")
        .single();

      if (error || !data) {
        throw new Error("Failed to update auth session.");
      }

      return toSessionView(data as UserSessionRow);
    }

    const { data, error } = await this.supabase
      .from("user_sessions")
      .insert({
        ...payload,
        created_at: nowIso,
      })
      .select("*")
      .single();

    if (error || !data) {
      throw new Error("Failed to insert auth session.");
    }

    return toSessionView(data as UserSessionRow);
  }

  async touchFromAccessToken(input: UpsertSessionInput): Promise<void> {
    let authSessionId: string | null = null;
    try {
      const claims = await this.resolveValidatedClaims(input.accessToken, input.userId);
      authSessionId = normalizeSessionKey(claims.sessionId);
    } catch {
      return;
    }

    if (!authSessionId) {
      return;
    }

    const nowMs = Date.now();
    const lastTouch = this.lastTouchByAuthSessionId.get(authSessionId) ?? 0;
    if (nowMs - lastTouch < this.minTouchIntervalMs) {
      return;
    }

    this.lastTouchByAuthSessionId.set(authSessionId, nowMs);

    try {
      await this.upsertFromAccessToken(input);
    } catch (error) {
      this.logger?.warn("Failed to touch auth session", {
        authSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async touchAuthSessionId(
    authSessionIdRaw: string,
    input: Omit<UpsertSessionInput, "accessToken">,
  ): Promise<boolean> {
    const authSessionId = normalizeSessionKey(authSessionIdRaw);
    if (!authSessionId) {
      return false;
    }

    const nowMs = Date.now();
    const lastTouch = this.lastTouchByAuthSessionId.get(authSessionId) ?? 0;
    if (nowMs - lastTouch < this.minTouchIntervalMs) {
      return true;
    }

    this.lastTouchByAuthSessionId.set(authSessionId, nowMs);

    try {
      const existing = await this.findByAuthSessionId(authSessionId);
      if (!existing || existing.user_id !== input.userId || existing.ended_at || existing.revoked_at) {
        return false;
      }

      const nowIso = new Date().toISOString();
      const { error } = await this.supabase
        .from("user_sessions")
        .update({
          last_seen_at: nowIso,
        })
        .eq("id", existing.id)
        .is("ended_at", null)
        .is("revoked_at", null);

      if (error) {
        throw error;
      }

      return true;
    } catch (error) {
      this.logger?.warn("Failed to touch auth session by id", {
        authSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async validateAccessTokenSession(accessToken: string, userId: string): Promise<boolean> {
    try {
      const claims = await this.resolveValidatedClaims(accessToken, userId);
      return this.validateAuthSessionId(claims.sessionId, userId);
    } catch {
      return false;
    }
  }

  async validateAuthSessionId(authSessionIdRaw: string, userId: string): Promise<boolean> {
    const authSessionId = normalizeSessionKey(authSessionIdRaw);
    const normalizedUserId = String(userId ?? "").trim();
    if (!authSessionId || !normalizedUserId) {
      return false;
    }

    const existing = await this.findByAuthSessionId(authSessionId);
    if (!existing) {
      return false;
    }

    return existing.user_id === normalizedUserId && !existing.ended_at && !existing.revoked_at;
  }

  async revokeCurrentAccessToken(accessToken: string, userId: string): Promise<boolean> {
    let claims: SupabaseJwtClaims & { sessionId: string };
    try {
      claims = await this.resolveValidatedClaims(accessToken, userId);
    } catch {
      return false;
    }

    try {
      await this.supabase.auth.admin.signOut(accessToken, "local");
    } catch (error) {
      this.logger?.warn("Supabase admin signOut failed", {
        error: error instanceof Error ? error.message : String(error),
        userId,
      });
    }

    return this.revokeSessionById(userId, claims.sessionId);
  }

  async revokeSessionById(userId: string, sessionIdRaw: string): Promise<boolean> {
    const existing = await this.findByAuthSessionId(sessionIdRaw);
    if (!existing || existing.user_id !== userId || existing.ended_at || existing.revoked_at) {
      return false;
    }

    const nowIso = new Date().toISOString();
    const { data, error } = await this.supabase
      .from("user_sessions")
      .update({
        ended_at: nowIso,
        revoked_at: nowIso,
        last_seen_at: nowIso,
      })
      .eq("id", existing.id)
      .is("ended_at", null)
      .is("revoked_at", null)
      .select("id")
      .maybeSingle();

    return !error && Boolean(data);
  }

  async listUserSessions(userId: string): Promise<SessionView[]> {
    const { data, error } = await this.supabase
      .from("user_sessions")
      .select("*")
      .eq("user_id", userId)
      .is("ended_at", null)
      .is("revoked_at", null)
      .order("last_seen_at", { ascending: false });

    if (error) {
      throw new Error("Failed to list user sessions.");
    }

    return ((data ?? []) as UserSessionRow[]).map(toSessionView);
  }

  private async findByAuthSessionId(sessionIdRaw: string): Promise<UserSessionRow | null> {
    const sessionId = normalizeSessionKey(sessionIdRaw);
    if (!sessionId) {
      return null;
    }

    const authSessionMatch = await this.queryByColumn("auth_session_id", sessionId);
    if (authSessionMatch) {
      return authSessionMatch;
    }

    return this.queryByColumn("session_token", sessionId);
  }

  private async queryByColumn(
    column: "auth_session_id" | "session_token",
    value: string,
  ): Promise<UserSessionRow | null> {
    if (column === "auth_session_id" && !isUuidLike(value)) {
      return null;
    }

    const { data, error } = await this.supabase
      .from("user_sessions")
      .select("*")
      .eq(column, value)
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error("Failed to fetch auth session.");
    }

    return (data as UserSessionRow | null) ?? null;
  }
}
