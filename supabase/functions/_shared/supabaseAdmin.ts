/// <reference path="./edge-runtime.d.ts" />
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.98.0";
import { HttpError } from "./http.ts";

let cachedAdminClient: SupabaseClient | null = null;
let cachedAnonClient: SupabaseClient | null = null;

function getSupabaseUrl(): string {
  const url = (Deno.env.get("SUPABASE_URL") ?? Deno.env.get("VITE_SUPABASE_URL") ?? "").trim();
  if (!url) {
    throw new HttpError(500, "SERVER_CONFIG_ERROR", "SUPABASE_URL nao configurada.");
  }
  return url;
}

function getServiceRoleKey(): string {
  const key =
    (
      Deno.env.get("MESSLY_SERVICE_ROLE_JWT") ??
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
      Deno.env.get("SUPABASE_SECRET_KEY") ??
      ""
    ).trim();

  if (!key) {
    throw new HttpError(
      500,
      "SERVER_CONFIG_ERROR",
      "SUPABASE_SERVICE_ROLE_KEY ou SUPABASE_SECRET_KEY nao configurada.",
    );
  }

  return key;
}

function getAnonKey(): string {
  const key =
    (
      Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
      Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY") ??
      Deno.env.get("SUPABASE_ANON_KEY") ??
      Deno.env.get("VITE_SUPABASE_ANON_KEY") ??
      ""
    ).trim();

  if (!key) {
    throw new HttpError(500, "SERVER_CONFIG_ERROR", "SUPABASE_ANON_KEY nao configurada.");
  }

  return key;
}

export function getSupabaseAdminClient(): SupabaseClient {
  if (cachedAdminClient) {
    return cachedAdminClient;
  }

  cachedAdminClient = createClient(getSupabaseUrl(), getServiceRoleKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: {
        "x-client-info": "messly-edge-admin",
      },
    },
  });

  return cachedAdminClient;
}

export function getSupabaseAnonClient(): SupabaseClient {
  if (cachedAnonClient) {
    return cachedAnonClient;
  }

  cachedAnonClient = createClient(getSupabaseUrl(), getAnonKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: {
        "x-client-info": "messly-edge-anon",
      },
    },
  });

  return cachedAnonClient;
}

export function createSupabaseRlsClient(accessToken: string): SupabaseClient {
  const token = String(accessToken ?? "").trim();
  if (!token) {
    throw new HttpError(401, "UNAUTHENTICATED", "Token de acesso ausente para o contexto RLS.");
  }

  return createClient(getSupabaseUrl(), getAnonKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: {
        authorization: `Bearer ${token}`,
        "x-client-info": "messly-edge-rls",
      },
    },
  });
}
