import { createClient } from "@supabase/supabase-js";

export interface UserRow {
  id: string;
  username: string;
  display_name: string | null;
  email: string | null;
  avatar_key: string | null;
  banner_key: string | null;
  avatar_hash: string | null;
  banner_hash: string | null;
  about: string | null;
  status: string | null;
  last_active: string | null;
  firebase_uid: string;
  public_id: string | null;
  created_at: string;
}

function getRequiredEnv(name: keyof ImportMetaEnv): string {
  const value = import.meta.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

function getSupabaseClientKey(): string {
  if (supabaseAnonKey) {
    return supabaseAnonKey;
  }

  if (supabasePublishableKey) {
    return supabasePublishableKey;
  }

  throw new Error("Missing Supabase key: set VITE_SUPABASE_ANON_KEY (recommended) or VITE_SUPABASE_PUBLISHABLE_KEY.");
}

const supabaseUrl = getRequiredEnv("VITE_SUPABASE_URL");
const supabaseClientKey = getSupabaseClientKey();

if (!supabaseAnonKey && supabasePublishableKey && import.meta.env.DEV) {
  console.warn(
    "VITE_SUPABASE_ANON_KEY nao configurado. Funcoes Edge podem retornar 401. Defina a anon key no .env/.hosting.",
  );
}

export function getSupabaseFunctionHeaders(): Record<string, string> | undefined {
  const functionKey = supabaseAnonKey || supabasePublishableKey;
  if (!functionKey) {
    return undefined;
  }

  return {
    apikey: functionKey,
  };
}

export const supabase = createClient(supabaseUrl, supabaseClientKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});
