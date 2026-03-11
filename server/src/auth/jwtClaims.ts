export interface SupabaseJwtClaims {
  userId: string;
  sessionId: string | null;
  email: string | null;
  expiresAt: number | null;
}

function decodeBase64Url(segment: string): string | null {
  const normalized = String(segment ?? "").trim();
  if (!normalized) {
    return null;
  }

  try {
    return Buffer.from(normalized, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

export function decodeSupabaseJwtClaims(tokenRaw: string): SupabaseJwtClaims | null {
  const token = String(tokenRaw ?? "").trim();
  if (!token) {
    return null;
  }

  const segments = token.split(".");
  if (segments.length < 2) {
    return null;
  }

  const payloadText = decodeBase64Url(segments[1] ?? "");
  if (!payloadText) {
    return null;
  }

  try {
    const payload = JSON.parse(payloadText) as Record<string, unknown>;
    const userId = String(payload.sub ?? "").trim();
    if (!userId) {
      return null;
    }

    const sessionId = String(payload.session_id ?? "").trim() || null;
    const email = String(payload.email ?? "").trim() || null;
    const expiresAt = typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp : null;

    return {
      userId,
      sessionId,
      email,
      expiresAt,
    };
  } catch {
    return null;
  }
}
