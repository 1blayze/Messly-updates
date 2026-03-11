import type { SupabaseClient } from "@supabase/supabase-js";
import { decodeSupabaseJwtClaims } from "../auth/jwtClaims";
import type { Logger } from "../infra/logger";

export interface SessionClientInfo {
  name?: string | null;
  version?: string | null;
  platform?: string | null;
}

interface UserSessionRow {
  id: string;
  user_id: string;
  session_token: string;
  ip_address: string;
  city: string | null;
  region: string | null;
  country: string | null;
  device: string;
  os: string;
  client_version: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  ended_at: string | null;
  revoked_at?: string | null;
}

export interface SessionView {
  id: string;
  device: string;
  os: string;
  clientVersion: string | null;
  location: string | null;
  ipAddressMasked: string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
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

function buildDeviceLabel(client: SessionClientInfo | null): string {
  const name = normalizeText(client?.name, 40);
  const version = normalizeText(client?.version, 32);
  if (name && version) {
    return `${name} ${version}`.slice(0, 80);
  }
  return name ?? "Messly Desktop";
}

function buildOsLabel(client: SessionClientInfo | null, userAgent: string | null): string {
  const platform = normalizeText(client?.platform, 40);
  if (platform) {
    return platform;
  }

  const agent = normalizeText(userAgent, 80);
  if (!agent) {
    return "unknown";
  }

  return agent.slice(0, 80);
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
  const parts = [row.city, row.region, row.country]
    .map((value) => normalizeText(value, 120))
    .filter((value, index, array): value is string => Boolean(value) && array.indexOf(value) === index);

  return parts.length > 0 ? parts.join(", ") : null;
}

function toSessionView(row: UserSessionRow): SessionView {
  return {
    id: row.id,
    device: row.device,
    os: row.os,
    clientVersion: normalizeText(row.client_version, 32),
    location: toLocation(row),
    ipAddressMasked: maskIpAddress(row.ip_address),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at ?? row.ended_at ?? null,
  };
}

export class AuthSessionManager {
  private readonly lastTouchByAuthSessionId = new Map<string, number>();

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly logger?: Logger,
    private readonly minTouchIntervalMs = 60_000,
  ) {}

  async upsertFromAccessToken(input: UpsertSessionInput): Promise<SessionView> {
    const claims = decodeSupabaseJwtClaims(input.accessToken);
    if (!claims?.sessionId || claims.userId !== input.userId) {
      throw new Error("Invalid Supabase session claims.");
    }

    const nowIso = new Date().toISOString();
    const existing = await this.findBySessionToken(claims.sessionId);
    const payload = {
      user_id: input.userId,
      session_token: claims.sessionId,
      ip_address: normalizeText(input.ipAddress, 120) ?? "unknown",
      device: buildDeviceLabel(input.client),
      os: buildOsLabel(input.client, input.userAgent),
      client_version: normalizeText(input.client?.version, 32),
      user_agent: normalizeText(input.userAgent, 512),
      last_seen_at: nowIso,
      ended_at: null,
    };

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
    const claims = decodeSupabaseJwtClaims(input.accessToken);
    const authSessionId = claims?.sessionId ?? null;
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
    authSessionId: string,
    input: Omit<UpsertSessionInput, "accessToken">,
  ): Promise<void> {
    const normalizedAuthSessionId = String(authSessionId ?? "").trim();
    if (!normalizedAuthSessionId) {
      return;
    }

    const nowMs = Date.now();
    const lastTouch = this.lastTouchByAuthSessionId.get(normalizedAuthSessionId) ?? 0;
    if (nowMs - lastTouch < this.minTouchIntervalMs) {
      return;
    }

    this.lastTouchByAuthSessionId.set(normalizedAuthSessionId, nowMs);

    try {
      const nowIso = new Date().toISOString();
      const { error } = await this.supabase
        .from("user_sessions")
        .update({
          ip_address: normalizeText(input.ipAddress, 120) ?? "unknown",
          device: buildDeviceLabel(input.client),
          os: buildOsLabel(input.client, input.userAgent),
          client_version: normalizeText(input.client?.version, 32),
          user_agent: normalizeText(input.userAgent, 512),
          last_seen_at: nowIso,
          ended_at: null,
        })
        .eq("session_token", normalizedAuthSessionId)
        .eq("user_id", input.userId)
        .is("ended_at", null);

      if (error) {
        throw error;
      }
    } catch (error) {
      this.logger?.warn("Failed to touch auth session by id", {
        authSessionId: normalizedAuthSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async validateAccessTokenSession(accessToken: string, userId: string): Promise<boolean> {
    const claims = decodeSupabaseJwtClaims(accessToken);
    if (!claims?.sessionId || claims.userId !== userId) {
      return false;
    }

    const existing = await this.findBySessionToken(claims.sessionId);
    if (!existing) {
      return false;
    }

    return existing.user_id === userId && !existing.ended_at;
  }

  async validateAuthSessionId(authSessionId: string, userId: string): Promise<boolean> {
    const normalizedAuthSessionId = String(authSessionId ?? "").trim();
    const normalizedUserId = String(userId ?? "").trim();
    if (!normalizedAuthSessionId || !normalizedUserId) {
      return false;
    }

    const existing = await this.findBySessionToken(normalizedAuthSessionId);
    if (!existing) {
      return false;
    }

    return existing.user_id === normalizedUserId && !existing.ended_at;
  }

  async revokeCurrentAccessToken(accessToken: string, userId: string): Promise<boolean> {
    const claims = decodeSupabaseJwtClaims(accessToken);
    if (!claims?.sessionId || claims.userId !== userId) {
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

    const nowIso = new Date().toISOString();
    const { data, error } = await this.supabase
      .from("user_sessions")
      .update({
        ended_at: nowIso,
        last_seen_at: nowIso,
      })
      .eq("session_token", claims.sessionId)
      .eq("user_id", userId)
      .is("ended_at", null)
      .select("id")
      .maybeSingle();

    return !error && Boolean(data);
  }

  async revokeSessionById(userId: string, sessionId: string): Promise<boolean> {
    const nowIso = new Date().toISOString();
    const { data, error } = await this.supabase
      .from("user_sessions")
      .update({
        ended_at: nowIso,
        last_seen_at: nowIso,
      })
      .eq("id", sessionId)
      .eq("user_id", userId)
      .is("ended_at", null)
      .select("id")
      .maybeSingle();

    return !error && Boolean(data);
  }

  async listUserSessions(userId: string): Promise<SessionView[]> {
    const { data, error } = await this.supabase
      .from("user_sessions")
      .select("*")
      .eq("user_id", userId)
      .order("last_seen_at", { ascending: false });

    if (error) {
      throw new Error("Failed to list user sessions.");
    }

    return ((data ?? []) as UserSessionRow[]).map(toSessionView);
  }

  private async findBySessionToken(sessionToken: string): Promise<UserSessionRow | null> {
    const { data, error } = await this.supabase
      .from("user_sessions")
      .select("*")
      .eq("session_token", sessionToken)
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error("Failed to fetch auth session.");
    }

    return (data as UserSessionRow | null) ?? null;
  }
}
