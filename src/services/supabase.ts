import { supabase, supabaseAnonKey } from "../lib/supabaseClient";
import { authService } from "./auth";

export interface UserRow {
  id: string;
  username: string;
  display_name: string | null;
  email: string | null;
  avatar_key: string | null;
  banner_key: string | null;
  avatar_hash: string | null;
  banner_hash: string | null;
  avatar_url: string | null;
  about: string | null;
  status: string | null;
  last_active: string | null;
  public_id: string | null;
  banner_color: string | null;
  profile_theme_primary_color: string | null;
  profile_theme_accent_color: string | null;
  spotify_connection: unknown | null;
  created_at: string;
  updated_at?: string | null;
}

export { supabase };

export function isDirectUsersRestBlocked(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const protocol = String(window.location.protocol ?? "").trim().toLowerCase();
  const hostname = String(window.location.hostname ?? "").trim().toLowerCase();
  const isLoopbackHost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  const isDesktopShell = protocol === "app:" || protocol === "file:";
  if (isLoopbackHost || isDesktopShell) {
    return false;
  }

  return import.meta.env.PROD;
}

export interface SupabaseFunctionHeadersOptions {
  requireAuth?: boolean;
}

export async function getSupabaseFunctionHeaders(
  options: SupabaseFunctionHeadersOptions = {},
): Promise<Record<string, string> | undefined> {
  if (!supabaseAnonKey) {
    return undefined;
  }

  if (options.requireAuth) {
    const validatedAccessToken = String(await authService.getValidatedEdgeAccessToken() ?? "").trim();
    const currentAccessToken = validatedAccessToken || String(await authService.getCurrentAccessToken() ?? "").trim();

    return {
      apikey: supabaseAnonKey,
      ...(currentAccessToken ? { authorization: `Bearer ${currentAccessToken}` } : {}),
    };
  }

  const currentAccessToken = String(await authService.getCurrentAccessToken() ?? "").trim();

  return {
    apikey: supabaseAnonKey,
    ...(currentAccessToken ? { authorization: `Bearer ${currentAccessToken}` } : {}),
  };
}
