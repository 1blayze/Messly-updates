import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { HttpError } from "./http.ts";

let cachedClient: SupabaseClient | null = null;

function getSupabaseUrl(): string {
  const url = (Deno.env.get("SUPABASE_URL") ?? Deno.env.get("VITE_SUPABASE_URL") ?? "").trim();
  if (!url) {
    throw new HttpError(500, "SERVER_CONFIG_ERROR", "SUPABASE_URL nao configurada.");
  }
  return url;
}

function getServiceRoleKey(): string {
  const key =
    (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY") ?? "").trim();
  if (!key) {
    throw new HttpError(500, "SERVER_CONFIG_ERROR", "SUPABASE_SERVICE_ROLE_KEY nao configurada.");
  }
  return key;
}

export function getSupabaseAdminClient(): SupabaseClient {
  if (cachedClient) {
    return cachedClient;
  }

  cachedClient = createClient(getSupabaseUrl(), getServiceRoleKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: {
        "x-client-info": "messly-edge",
      },
    },
  });

  return cachedClient;
}
