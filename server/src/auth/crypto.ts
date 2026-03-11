import { createCipheriv, createDecipheriv, createHmac, createHash, randomInt, randomBytes, timingSafeEqual } from "node:crypto";

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(String(secret ?? "").trim()).digest();
}

export function normalizeEmail(emailRaw: string): string {
  return String(emailRaw ?? "").trim().toLowerCase();
}

export function generateOtpCode(length = 6): string {
  const digits = Math.max(4, Math.min(8, Math.trunc(length)));
  let code = "";
  while (code.length < digits) {
    code += String(randomInt(0, 10));
  }
  return code.slice(0, digits);
}

export function hashVerificationCode(secret: string, purpose: string, email: string, code: string): string {
  const normalizedPurpose = String(purpose ?? "").trim().toLowerCase();
  const normalizedEmail = normalizeEmail(email);
  const normalizedCode = String(code ?? "").trim();
  return createHmac("sha256", deriveKey(secret))
    .update(`${normalizedPurpose}:${normalizedEmail}:${normalizedCode}`)
    .digest("hex");
}

export function encryptSensitiveValue(secret: string, valueRaw: string): string {
  const value = String(valueRaw ?? "");
  const iv = randomBytes(12);
  const key = deriveKey(secret);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptSensitiveValue(secret: string, encryptedRaw: string): string | null {
  const encrypted = String(encryptedRaw ?? "").trim();
  if (!encrypted) {
    return null;
  }

  const [ivRaw, tagRaw, payloadRaw] = encrypted.split(".");
  if (!ivRaw || !tagRaw || !payloadRaw) {
    return null;
  }

  try {
    const key = deriveKey(secret);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payloadRaw, "base64url")),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}

export function secureCompareHex(leftRaw: string, rightRaw: string): boolean {
  const left = String(leftRaw ?? "").trim();
  const right = String(rightRaw ?? "").trim();
  if (!left || !right || left.length !== right.length) {
    return false;
  }

  try {
    return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
  } catch {
    return false;
  }
}
