import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleSignup } from "../../auth/signup";
import type { AuthDependencies, AuthRequestContext, SignupRequestBody } from "../../auth/types";
import type { GatewayEnv } from "../../infra/env";
import { prepareRegistrationRiskInput, reserveRegistrationLease } from "../evaluateRegistrationRisk";

type Row = Record<string, unknown>;

interface SignupMockResult {
  data: {
    user: {
      id: string;
    };
  } | null;
  error: { message?: string } | null;
}

function toMs(value: unknown): number {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

class FakeSupabaseQuery implements PromiseLike<{ data: unknown; count?: number | null; error: null }> {
  private mode: "select" | "delete" = "select";
  private selectedColumns: string[] | null = null;
  private head = false;
  private shouldCount = false;
  private limitSize: number | null = null;
  private filters: Array<(row: Row) => boolean> = [];

  constructor(
    private readonly supabase: FakeSupabase,
    private readonly table: string,
  ) {}

  select(columns: string, options?: { head?: boolean; count?: "exact" | string }): FakeSupabaseQuery {
    this.mode = "select";
    this.selectedColumns = columns
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean);
    this.head = Boolean(options?.head);
    this.shouldCount = String(options?.count ?? "").trim().toLowerCase() === "exact";
    return this;
  }

  insert(payload: Row | Row[]): Promise<{ data: Row[]; error: null }> {
    const rows = Array.isArray(payload) ? payload : [payload];
    const inserted: Row[] = rows.map((row) => this.supabase.insertRow(this.table, row));
    return Promise.resolve({
      data: inserted,
      error: null,
    });
  }

  upsert(payload: Row | Row[], options?: { onConflict?: string }): Promise<{ data: Row[]; error: null }> {
    const rows = Array.isArray(payload) ? payload : [payload];
    const conflictColumn = String(options?.onConflict ?? "").trim();
    const upserted: Row[] = rows.map((row) => this.supabase.upsertRow(this.table, row, conflictColumn));
    return Promise.resolve({
      data: upserted,
      error: null,
    });
  }

  delete(): FakeSupabaseQuery {
    this.mode = "delete";
    return this;
  }

  eq(column: string, value: unknown): FakeSupabaseQuery {
    this.filters.push((row) => String(row[column] ?? "") === String(value ?? ""));
    return this;
  }

  gte(column: string, value: unknown): FakeSupabaseQuery {
    const threshold = toMs(value);
    this.filters.push((row) => {
      const candidate = toMs(row[column]);
      if (Number.isFinite(candidate) && Number.isFinite(threshold)) {
        return candidate >= threshold;
      }
      return String(row[column] ?? "") >= String(value ?? "");
    });
    return this;
  }

  gt(column: string, value: unknown): FakeSupabaseQuery {
    const threshold = toMs(value);
    this.filters.push((row) => {
      const candidate = toMs(row[column]);
      if (Number.isFinite(candidate) && Number.isFinite(threshold)) {
        return candidate > threshold;
      }
      return String(row[column] ?? "") > String(value ?? "");
    });
    return this;
  }

  lt(column: string, value: unknown): FakeSupabaseQuery {
    const threshold = toMs(value);
    this.filters.push((row) => {
      const candidate = toMs(row[column]);
      if (Number.isFinite(candidate) && Number.isFinite(threshold)) {
        return candidate < threshold;
      }
      return String(row[column] ?? "") < String(value ?? "");
    });
    return this;
  }

  not(column: string, operator: string, value: unknown): FakeSupabaseQuery {
    if (operator === "is" && value === null) {
      this.filters.push((row) => row[column] !== null && row[column] !== undefined);
    }
    return this;
  }

  limit(size: number): FakeSupabaseQuery {
    this.limitSize = Math.max(0, Math.trunc(size));
    return this;
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const { data } = await this.execute();
    const list = Array.isArray(data) ? data : [];
    return {
      data: list[0] ?? null,
      error: null,
    };
  }

  then<TResult1 = { data: unknown; count?: number | null; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; count?: number | null; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled ?? undefined, onrejected ?? undefined);
  }

  private async execute(): Promise<{ data: unknown; count?: number | null; error: null }> {
    const sourceRows = this.supabase.getRows(this.table);
    const filtered = sourceRows.filter((row) => this.filters.every((filterFn) => filterFn(row)));
    const limited = this.limitSize === null ? filtered : filtered.slice(0, this.limitSize);

    if (this.mode === "delete") {
      this.supabase.deleteRows(this.table, (row) => this.filters.every((filterFn) => filterFn(row)));
      return {
        data: [],
        count: null,
        error: null,
      };
    }

    if (this.shouldCount && this.head) {
      return {
        data: null,
        count: limited.length,
        error: null,
      };
    }

    const selected = limited.map((row) => {
      if (!this.selectedColumns || this.selectedColumns.length === 0 || this.selectedColumns[0] === "*") {
        return { ...row };
      }
      const next: Row = {};
      for (const column of this.selectedColumns) {
        next[column] = row[column];
      }
      return next;
    });

    return {
      data: selected,
      count: this.shouldCount ? selected.length : null,
      error: null,
    };
  }
}

class FakeSupabase {
  readonly tables: Record<string, Row[]> = Object.create(null);
  readonly rpcCalls: string[] = [];
  private leaseSequence = 0;

  from(table: string): FakeSupabaseQuery {
    if (!this.tables[table]) {
      this.tables[table] = [];
    }
    return new FakeSupabaseQuery(this, table);
  }

  async rpc(functionName: string, args: Record<string, unknown>): Promise<{ data: unknown; error: null }> {
    this.rpcCalls.push(functionName);
    if (functionName === "registration_try_acquire_lease") {
      return {
        data: [this.acquireLease(args)],
        error: null,
      };
    }
    if (functionName === "registration_release_lease") {
      return {
        data: this.releaseLease(args),
        error: null,
      };
    }
    if (functionName === "registration_consume_lease") {
      return {
        data: this.consumeLease(args),
        error: null,
      };
    }
    if (functionName === "registration_cleanup_rate_limit_leases") {
      return {
        data: 0,
        error: null,
      };
    }
    return {
      data: null,
      error: null,
    };
  }

  getRows(table: string): Row[] {
    if (!this.tables[table]) {
      this.tables[table] = [];
    }
    return this.tables[table];
  }

  insertRow(table: string, row: Row): Row {
    const nextRow: Row = {
      ...row,
    };
    if (!Number.isFinite(toMs(nextRow.created_at))) {
      nextRow.created_at = new Date().toISOString();
    }
    if (nextRow.id === undefined || nextRow.id === null) {
      nextRow.id = this.getRows(table).length + 1;
    }
    this.getRows(table).push(nextRow);
    return nextRow;
  }

  upsertRow(table: string, row: Row, conflictColumn: string): Row {
    const normalizedConflict = String(conflictColumn ?? "").trim();
    if (!normalizedConflict) {
      return this.insertRow(table, row);
    }
    const rows = this.getRows(table);
    const existingIndex = rows.findIndex(
      (entry) => String(entry[normalizedConflict] ?? "") === String(row[normalizedConflict] ?? ""),
    );
    if (existingIndex < 0) {
      return this.insertRow(table, row);
    }
    const updated: Row = {
      ...rows[existingIndex],
      ...row,
    };
    if (!Number.isFinite(toMs(updated.updated_at))) {
      updated.updated_at = new Date().toISOString();
    }
    rows[existingIndex] = updated;
    return updated;
  }

  deleteRows(table: string, predicate: (row: Row) => boolean): void {
    const rows = this.getRows(table);
    this.tables[table] = rows.filter((row) => !predicate(row));
  }

  private acquireLease(args: Record<string, unknown>): Row {
    const nowIso = String(args.p_now ?? new Date().toISOString());
    const nowMs = toMs(nowIso);
    const ipAddress = String(args.p_ip_address ?? "");
    const fingerprintHash = String(args.p_fingerprint_hash ?? "");
    const ipLimit = Number(args.p_ip_limit ?? 3);
    const fingerprintLimit = Number(args.p_fingerprint_limit ?? 2);
    const ipWindowMs = Number(args.p_ip_window_seconds ?? 86_400) * 1000;
    const fingerprintWindowMs = Number(args.p_fingerprint_window_seconds ?? 86_400) * 1000;
    const leaseTtlMs = Number(args.p_lease_ttl_seconds ?? 1_200) * 1000;
    const leases = this.getRows("registration_rate_limit_leases");

    for (const lease of leases) {
      if (String(lease.lease_status ?? "") !== "reserved") {
        continue;
      }
      const expiresMs = toMs(lease.expires_at);
      if (!Number.isFinite(expiresMs) || expiresMs > nowMs) {
        continue;
      }
      lease.lease_status = "expired";
      lease.released_at = nowIso;
      lease.release_reason = String(lease.release_reason ?? "lease_expired");
    }

    const ipWindowStart = nowMs - ipWindowMs;
    const fingerprintWindowStart = nowMs - fingerprintWindowMs;

    const ipCount = leases.filter((lease) => {
      if (String(lease.ip_address ?? "") !== ipAddress) {
        return false;
      }
      const createdAtMs = toMs(lease.created_at);
      if (!Number.isFinite(createdAtMs) || createdAtMs < ipWindowStart) {
        return false;
      }
      const status = String(lease.lease_status ?? "");
      if (status === "consumed") {
        return true;
      }
      if (status !== "reserved") {
        return false;
      }
      return toMs(lease.expires_at) > nowMs;
    }).length;

    if (ipCount >= ipLimit) {
      return {
        allowed: false,
        reason: "ip_limit",
        lease_id: null,
        ip_count: ipCount,
        fingerprint_count: null,
      };
    }

    const fingerprintCount = leases.filter((lease) => {
      if (String(lease.fingerprint_hash ?? "") !== fingerprintHash) {
        return false;
      }
      const createdAtMs = toMs(lease.created_at);
      if (!Number.isFinite(createdAtMs) || createdAtMs < fingerprintWindowStart) {
        return false;
      }
      const status = String(lease.lease_status ?? "");
      if (status === "consumed") {
        return true;
      }
      if (status !== "reserved") {
        return false;
      }
      return toMs(lease.expires_at) > nowMs;
    }).length;

    if (fingerprintCount >= fingerprintLimit) {
      return {
        allowed: false,
        reason: "fingerprint_limit",
        lease_id: null,
        ip_count: ipCount,
        fingerprint_count: fingerprintCount,
      };
    }

    const leaseId = `lease-${++this.leaseSequence}`;
    leases.push({
      id: leaseId,
      ip_address: ipAddress,
      fingerprint_hash: fingerprintHash,
      lease_status: "reserved",
      created_at: nowIso,
      expires_at: new Date(nowMs + leaseTtlMs).toISOString(),
      consumed_at: null,
      released_at: null,
      release_reason: null,
    });

    return {
      allowed: true,
      reason: "ok",
      lease_id: leaseId,
      ip_count: ipCount + 1,
      fingerprint_count: fingerprintCount + 1,
    };
  }

  private releaseLease(args: Record<string, unknown>): boolean {
    const leaseId = String(args.p_lease_id ?? "");
    const reason = String(args.p_reason ?? "released");
    const nowIso = String(args.p_now ?? new Date().toISOString());
    const lease = this.getRows("registration_rate_limit_leases").find(
      (entry) => String(entry.id ?? "") === leaseId,
    );
    if (!lease || String(lease.lease_status ?? "") !== "reserved") {
      return false;
    }
    lease.lease_status = "released";
    lease.released_at = nowIso;
    lease.release_reason = reason;
    return true;
  }

  private consumeLease(args: Record<string, unknown>): boolean {
    const leaseId = String(args.p_lease_id ?? "");
    const nowIso = String(args.p_now ?? new Date().toISOString());
    const nowMs = toMs(nowIso);
    const lease = this.getRows("registration_rate_limit_leases").find(
      (entry) => String(entry.id ?? "") === leaseId,
    );
    if (!lease || String(lease.lease_status ?? "") !== "reserved") {
      return false;
    }
    if (toMs(lease.expires_at) <= nowMs) {
      return false;
    }
    lease.lease_status = "consumed";
    lease.consumed_at = nowIso;
    return true;
  }
}

interface BuildDepsOptions {
  envOverrides?: Partial<GatewayEnv>;
  signUpHandler?: (payload: { email: string; password: string }) => Promise<SignupMockResult>;
}

interface BuildDepsResult {
  deps: AuthDependencies;
  adminSupabase: FakeSupabase;
  getSignupCalls: () => number;
}

function buildEnv(overrides: Partial<GatewayEnv> = {}): GatewayEnv {
  return {
    port: 8788,
    shardCount: 1,
    localShardIndex: 0,
    supabaseUrl: "https://example.supabase.co",
    supabaseAnonKey: "anon",
    supabaseServiceRoleKey: "service",
    redisUrl: "",
    eventBusChannel: "messly:eventbus",
    presenceTtlSeconds: 120,
    typingTtlMs: 5000,
    gatewayMetricsPath: "/metrics",
    redisPubSubRetryAttempts: 3,
    authOtpTtlSeconds: 600,
    authOtpMaxAttempts: 5,
    turnstileSecretKey: "secret-key",
    registrationIpLimitMax: 3,
    registrationIpLimitWindowHours: 24,
    captchaFailLimit: 5,
    captchaFailWindowMinutes: 10,
    captchaBlockHours: 24,
    fingerprintLimitMax: 2,
    fingerprintLimitWindowHours: 24,
    registrationLeaseTtlMinutes: 20,
    enableDisposableEmailBlock: true,
    fingerprintDistinctIpThreshold: 4,
    ipDistinctFingerprintThreshold: 6,
    domainBurstThreshold: 8,
    maxCorrelationSample: 120,
    correlationWindowMinutes: 60,
    suspiciousEventWindowHours: 24,
    suspiciousReincidenceThreshold: 2,
    allowedOrigins: [],
    allowElectronOrigin: true,
    r2Bucket: "bucket",
    r2Endpoint: "https://example.r2.local",
    r2AccessKeyId: "key",
    r2SecretAccessKey: "secret",
    r2Region: "auto",
    r2ForcePathStyle: true,
    mediaCdnBaseUrl: "https://cdn.example.local",
    ...overrides,
  };
}

function buildDeps(options: BuildDepsOptions = {}): BuildDepsResult {
  const adminSupabase = new FakeSupabase();
  let signupCalls = 0;
  const signUpHandler =
    options.signUpHandler ??
    (async () => ({
      data: {
        user: {
          id: `user-${signupCalls}`,
        },
      },
      error: null,
    }));

  const deps: AuthDependencies = {
    adminSupabase: adminSupabase as unknown as SupabaseClient,
    createPublicSupabase: () =>
      ({
        auth: {
          signUp: async (payload: { email: string; password: string }) => {
            signupCalls += 1;
            return signUpHandler(payload);
          },
        },
      }) as unknown as SupabaseClient,
    sessionManager: {} as AuthDependencies["sessionManager"],
    rateLimiter: {
      consume: async () => ({
        allowed: true,
        retryAfterMs: 0,
        remaining: 1,
        total: 1,
      }),
    },
    env: buildEnv(options.envOverrides),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };

  return {
    deps,
    adminSupabase,
    getSignupCalls: () => signupCalls,
  };
}

function buildContext(ipAddress = "192.168.0.10"): AuthRequestContext {
  return {
    ipAddress,
    userAgent: "messly-test-agent",
    origin: "http://localhost:5173",
    authorizationToken: null,
  };
}

function hexFingerprint(seed: number): string {
  return seed.toString(16).padStart(64, "0").slice(-64);
}

function buildBody(overrides: Partial<SignupRequestBody> = {}): SignupRequestBody {
  return {
    email: "tester@example.com",
    password: "StrongPass123",
    profile: {
      displayName: "Tester",
      username: "tester",
    },
    turnstileToken: "turnstile-token-valid",
    registrationFingerprint: hexFingerprint(1),
    ...overrides,
  };
}

function expectAuthError(error: unknown, code: string, status: number): void {
  const casted = error as { code?: unknown; status?: unknown; message?: unknown };
  assert.equal(String(casted?.code ?? ""), code);
  assert.equal(Number(casted?.status ?? 0), status);
  assert.ok(String(casted?.message ?? "").trim().length > 0);
}

function setupFetchSuccess(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        success: true,
        "error-codes": [],
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("creates lease successfully through atomic reserve", async () => {
  const { deps, adminSupabase } = buildDeps();
  const context = buildContext("10.0.0.2");
  const prepared = prepareRegistrationRiskInput({
    email: "lease@test.com",
    registrationFingerprint: hexFingerprint(10),
  });

  const lease = await reserveRegistrationLease(deps, context, prepared);
  assert.ok(lease.leaseId);
  const rows = adminSupabase.getRows("registration_rate_limit_leases");
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0]?.lease_status ?? ""), "reserved");
});

test("denies lease by ip_limit", async () => {
  const { deps, adminSupabase } = buildDeps();
  const context = buildContext("10.0.0.3");
  const prepared = prepareRegistrationRiskInput({
    email: "iplimit@test.com",
    registrationFingerprint: hexFingerprint(11),
  });
  for (let index = 0; index < 3; index += 1) {
    adminSupabase.insertRow("registration_rate_limit_leases", {
      id: `consumed-ip-${index}`,
      ip_address: context.ipAddress,
      fingerprint_hash: hexFingerprint(200 + index),
      lease_status: "consumed",
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
  }

  await assert.rejects(
    () => reserveRegistrationLease(deps, context, prepared),
    (error: unknown) => {
      expectAuthError(error, "REGISTRATION_TOO_MANY_ATTEMPTS", 429);
      return true;
    },
  );
});

test("denies lease by fingerprint_limit", async () => {
  const { deps, adminSupabase } = buildDeps();
  const prepared = prepareRegistrationRiskInput({
    email: "fingerprintlimit@test.com",
    registrationFingerprint: hexFingerprint(12),
  });
  const context = buildContext("10.0.0.4");
  for (let index = 0; index < 2; index += 1) {
    adminSupabase.insertRow("registration_rate_limit_leases", {
      id: `consumed-fp-${index}`,
      ip_address: `10.0.1.${index + 1}`,
      fingerprint_hash: prepared.fingerprintHash,
      lease_status: "consumed",
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
  }

  await assert.rejects(
    () => reserveRegistrationLease(deps, context, prepared),
    (error: unknown) => {
      expectAuthError(error, "REGISTRATION_TOO_MANY_ATTEMPTS", 429);
      return true;
    },
  );
});

test("concurrent signup requests by same IP respect atomic limit", async () => {
  const { deps } = buildDeps();
  const restoreFetch = setupFetchSuccess();

  try {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) =>
        handleSignup(
          deps,
          buildContext("172.20.0.1"),
          buildBody({
            email: `ip-concurrent-${index}@example.com`,
            registrationFingerprint: hexFingerprint(100 + index),
          }),
        ),
      ),
    );
    const successCount = results.filter((result) => result.status === "fulfilled").length;
    const rateLimitedCount = results.filter(
      (result) => result.status === "rejected" && String((result.reason as { code?: unknown }).code ?? "") === "REGISTRATION_TOO_MANY_ATTEMPTS",
    ).length;
    assert.equal(successCount, 3);
    assert.equal(rateLimitedCount, 2);
  } finally {
    restoreFetch();
  }
});

test("concurrent signup requests by same fingerprint respect atomic limit", async () => {
  const { deps } = buildDeps();
  const restoreFetch = setupFetchSuccess();
  const sharedFingerprint = hexFingerprint(5000);

  try {
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, index) =>
        handleSignup(
          deps,
          buildContext(`172.21.0.${index + 1}`),
          buildBody({
            email: `fp-concurrent-${index}@example.com`,
            registrationFingerprint: sharedFingerprint,
          }),
        ),
      ),
    );
    const successCount = results.filter((result) => result.status === "fulfilled").length;
    const rateLimitedCount = results.filter(
      (result) => result.status === "rejected" && String((result.reason as { code?: unknown }).code ?? "") === "REGISTRATION_TOO_MANY_ATTEMPTS",
    ).length;
    assert.equal(successCount, 2);
    assert.equal(rateLimitedCount, 2);
  } finally {
    restoreFetch();
  }
});

test("releases lease when captcha fails", async () => {
  const { deps, adminSupabase } = buildDeps();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        success: false,
        "error-codes": ["invalid-input-response"],
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );

  try {
    await assert.rejects(
      () => handleSignup(deps, buildContext("10.0.0.20"), buildBody({ email: "captcha-fail@test.com" })),
      (error: unknown) => {
        expectAuthError(error, "CAPTCHA_INVALID", 403);
        return true;
      },
    );
    const leases = adminSupabase.getRows("registration_rate_limit_leases");
    assert.equal(leases.length, 1);
    assert.equal(String(leases[0]?.lease_status ?? ""), "released");
    assert.equal(String(leases[0]?.release_reason ?? ""), "captcha_invalid");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("releases lease when provider signup fails", async () => {
  const { deps, adminSupabase } = buildDeps({
    signUpHandler: async () => ({
      data: null,
      error: {
        message: "provider internal failure",
      },
    }),
  });
  const restoreFetch = setupFetchSuccess();

  try {
    await assert.rejects(
      () => handleSignup(deps, buildContext("10.0.0.21"), buildBody({ email: "provider-fail@test.com" })),
      (error: unknown) => {
        expectAuthError(error, "REGISTRATION_UNABLE", 400);
        return true;
      },
    );
    const leases = adminSupabase.getRows("registration_rate_limit_leases");
    assert.equal(String(leases[0]?.lease_status ?? ""), "released");
    assert.equal(String(leases[0]?.release_reason ?? ""), "provider_error");
  } finally {
    restoreFetch();
  }
});

test("consumes lease when signup succeeds", async () => {
  const { deps, adminSupabase } = buildDeps();
  const restoreFetch = setupFetchSuccess();

  try {
    const response = await handleSignup(deps, buildContext("10.0.0.22"), buildBody({ email: "consume@test.com" }));
    assert.equal(response.status, "verification_required");
    const leases = adminSupabase.getRows("registration_rate_limit_leases");
    assert.equal(String(leases[0]?.lease_status ?? ""), "consumed");
    assert.ok(String(leases[0]?.consumed_at ?? "").length > 0);
  } finally {
    restoreFetch();
  }
});

test("rejects invalid fingerprint format", async () => {
  const { deps } = buildDeps();
  await assert.rejects(
    () =>
      handleSignup(
        deps,
        buildContext(),
        buildBody({
          registrationFingerprint: "invalid-fingerprint",
        }),
      ),
    (error: unknown) => {
      expectAuthError(error, "REGISTER_PAYLOAD_INVALID", 400);
      return true;
    },
  );
});

test("rejects oversized turnstile token", async () => {
  const { deps } = buildDeps();
  await assert.rejects(
    () =>
      handleSignup(
        deps,
        buildContext(),
        buildBody({
          turnstileToken: "t".repeat(2_049),
        }),
      ),
    (error: unknown) => {
      expectAuthError(error, "REGISTER_PAYLOAD_INVALID", 400);
      return true;
    },
  );
});

test("rejects missing turnstile token", async () => {
  const { deps } = buildDeps();
  await assert.rejects(
    () =>
      handleSignup(
        deps,
        buildContext(),
        buildBody({
          turnstileToken: "",
        }),
      ),
    (error: unknown) => {
      expectAuthError(error, "REGISTER_PAYLOAD_INVALID", 400);
      return true;
    },
  );
});

test("releases lease when captcha token is expired", async () => {
  const { deps, adminSupabase } = buildDeps();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        success: false,
        "error-codes": ["timeout-or-duplicate"],
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );

  try {
    await assert.rejects(
      () => handleSignup(deps, buildContext("10.0.0.24"), buildBody({ email: "captcha-expired@test.com" })),
      (error: unknown) => {
        expectAuthError(error, "CAPTCHA_EXPIRED", 400);
        return true;
      },
    );
    const leases = adminSupabase.getRows("registration_rate_limit_leases");
    assert.equal(String(leases[0]?.lease_status ?? ""), "released");
    assert.equal(String(leases[0]?.release_reason ?? ""), "captcha_expired");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects oversized email payload", async () => {
  const { deps } = buildDeps();
  await assert.rejects(
    () =>
      handleSignup(
        deps,
        buildContext(),
        buildBody({
          email: `${"a".repeat(250)}@x.com`,
        }),
      ),
    (error: unknown) => {
      expectAuthError(error, "REGISTER_PAYLOAD_INVALID", 400);
      return true;
    },
  );
});

test("captcha_network_error blocks signup but does not create punitive IP block", async () => {
  const { deps, adminSupabase } = buildDeps();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network_down");
  };

  try {
    for (let index = 0; index < 6; index += 1) {
      await assert.rejects(
        () =>
          handleSignup(
            deps,
            buildContext("10.0.0.40"),
            buildBody({
              email: `network-${index}@example.com`,
              registrationFingerprint: hexFingerprint(7000 + index),
            }),
          ),
        (error: unknown) => {
          expectAuthError(error, "CAPTCHA_NETWORK_ERROR", 403);
          return true;
        },
      );
    }
    assert.equal(adminSupabase.getRows("blocked_ips").length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider already-registered error is neutral and does not enumerate emails", async () => {
  const { deps } = buildDeps({
    signUpHandler: async () => ({
      data: null,
      error: {
        message: "User already registered",
      },
    }),
  });
  const restoreFetch = setupFetchSuccess();

  try {
    await assert.rejects(
      () => handleSignup(deps, buildContext("10.0.0.50"), buildBody({ email: "enum@test.com" })),
      (error: unknown) => {
        const casted = error as { code?: unknown; status?: unknown; message?: unknown };
        assert.equal(String(casted.code ?? ""), "REGISTRATION_UNABLE");
        assert.equal(Number(casted.status ?? 0), 400);
        assert.equal(String(casted.message ?? ""), "Unable to complete registration. Please try again later.");
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test("provider technical errors do not leak raw details to client", async () => {
  const { deps } = buildDeps({
    signUpHandler: async () => ({
      data: null,
      error: {
        message: "database timeout 42P01: internal detail",
      },
    }),
  });
  const restoreFetch = setupFetchSuccess();

  try {
    await assert.rejects(
      () => handleSignup(deps, buildContext("10.0.0.51"), buildBody({ email: "provider-raw@test.com" })),
      (error: unknown) => {
        const casted = error as { message?: unknown };
        assert.equal(String(casted.message ?? ""), "Unable to complete registration. Please try again later.");
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test("loads risk thresholds from env configuration", async () => {
  const { deps, adminSupabase } = buildDeps({
    envOverrides: {
      domainBurstThreshold: 1,
      suspiciousReincidenceThreshold: 1,
    },
  });

  adminSupabase.insertRow("registration_attempts_by_email_domain", {
    email_domain: "custom-risk.test",
    ip_address: "9.9.9.9",
    fingerprint_hash: prepareRegistrationRiskInput({
      email: "a@custom-risk.test",
      registrationFingerprint: hexFingerprint(300),
    }).fingerprintHash,
    created_at: new Date().toISOString(),
  });

  adminSupabase.insertRow("suspicious_registration_events", {
    event_type: "suspicious_registration_pattern",
    ip_address: "10.0.0.60",
    fingerprint_hash: prepareRegistrationRiskInput({
      email: "b@custom-risk.test",
      registrationFingerprint: hexFingerprint(301),
    }).fingerprintHash,
    created_at: new Date().toISOString(),
  });

  await assert.rejects(
    () =>
      handleSignup(
        deps,
        buildContext("10.0.0.60"),
        buildBody({
          email: "user@custom-risk.test",
          registrationFingerprint: hexFingerprint(301),
        }),
      ),
    (error: unknown) => {
      expectAuthError(error, "REGISTRATION_TEMPORARILY_BLOCKED", 403);
      return true;
    },
  );
});

test("does not execute cleanup RPC in request path", async () => {
  const { deps, adminSupabase } = buildDeps();
  const restoreFetch = setupFetchSuccess();

  try {
    await handleSignup(deps, buildContext("10.0.0.70"), buildBody({ email: "nocleanup@test.com" }));
    assert.equal(
      adminSupabase.rpcCalls.includes("registration_cleanup_rate_limit_leases"),
      false,
    );
  } finally {
    restoreFetch();
  }
});
