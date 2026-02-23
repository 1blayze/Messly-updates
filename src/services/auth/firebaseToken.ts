import { firebaseAuth } from "../firebase";
import { getSupabaseFunctionHeaders } from "../supabase";

export type EdgeAuthMode = "firebase" | "supabase";

interface EdgeHeaderOptions {
  mode?: EdgeAuthMode;
  forceRefresh?: boolean;
}

export async function getFirebaseIdToken(forceRefresh = false): Promise<string> {
  const user = firebaseAuth.currentUser;
  if (!user) {
    throw new Error("AUTH_REQUIRED");
  }

  const token = await user.getIdToken(forceRefresh);
  if (!token) {
    throw new Error("AUTH_REQUIRED");
  }

  return token;
}

export async function getAuthenticatedEdgeHeaders(
  extraHeaders?: Record<string, string>,
  options: EdgeHeaderOptions = {},
): Promise<Record<string, string>> {
  const firebaseToken = await getFirebaseIdToken(Boolean(options.forceRefresh));
  const base = getSupabaseFunctionHeaders() ?? {};
  const apikey = String(base.apikey ?? "").trim();
  const isLikelyJwt = apikey.includes(".");
  const enableSeparateFirebaseHeader =
    String(import.meta.env.VITE_EDGE_USE_FIREBASE_HEADER ?? "")
      .trim()
      .toLowerCase() === "true";
  const mode = options.mode ?? "firebase";

  const headers: Record<string, string> = {
    ...base,
    ...(extraHeaders ?? {}),
  };

  if (mode === "supabase") {
    headers.Authorization = isLikelyJwt ? `Bearer ${apikey}` : `Bearer ${firebaseToken}`;

    // Keep Firebase token in an alternative header for function-level auth checks.
    // Prefer allow-listed headers to avoid CORS preflight failures.
    if (enableSeparateFirebaseHeader) {
      headers["x-firebase-authorization"] = `Bearer ${firebaseToken}`;
    } else {
      headers["x-client-info"] = `Bearer ${firebaseToken}`;
    }
    return headers;
  }

  // Legacy mode (default): Firebase token in Authorization for older deployments.
  headers.Authorization = `Bearer ${firebaseToken}`;

  return headers;
}
