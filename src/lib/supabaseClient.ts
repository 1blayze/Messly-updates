import { createClient } from "@supabase/supabase-js";

function getRequiredEnv(name: keyof ImportMetaEnv): string {
  const value = String(import.meta.env[name] ?? "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  if ((name === "VITE_SUPABASE_ANON_KEY" || name === "VITE_SUPABASE_PUBLISHABLE_KEY") && value.includes("service_role")) {
    throw new Error("Supabase service_role key must not be used in the client bundle.");
  }
  if ((name === "VITE_SUPABASE_ANON_KEY" || name === "VITE_SUPABASE_PUBLISHABLE_KEY") && value.startsWith("sb_secret_")) {
    throw new Error("Supabase secret key must not be used in the client bundle.");
  }
  return value;
}

export const supabaseUrl = getRequiredEnv("VITE_SUPABASE_URL");
export const supabasePublicKey =
  String(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "").trim() ||
  String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? "").trim() ||
  (() => {
    throw new Error("Missing required environment variable: VITE_SUPABASE_PUBLISHABLE_KEY or VITE_SUPABASE_ANON_KEY");
  })();

if (supabasePublicKey.includes("service_role") || supabasePublicKey.startsWith("sb_secret_")) {
  throw new Error("Supabase service_role/secret key must not be used in the client bundle.");
}

// Backwards-compatible export name used throughout the app.
export const supabaseAnonKey = supabasePublicKey;

export const supabase = createClient(supabaseUrl, supabasePublicKey, {
  auth: {
    // Persist to local storage so Edge Function calls reuse a fresh JWT in dev and web.
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
  realtime: {
    params: {
      eventsPerSecond: 10,
    },
  },
});
