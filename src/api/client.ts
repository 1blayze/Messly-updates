import { supabase } from "../services/supabase";
import { authService } from "../services/auth";
import { getGatewaySocketUrl } from "../config/domains";

export async function getSupabaseAccessToken(): Promise<string | null> {
  return authService.getCurrentAccessToken();
}

export function getGatewayUrl(): string | null {
  return getGatewaySocketUrl();
}

export async function getCurrentUserId(): Promise<string | null> {
  return authService.getCurrentUserId();
}

export { supabase };
