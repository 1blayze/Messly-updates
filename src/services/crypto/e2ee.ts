import { base64ToBytes, bytesToBase64, toArrayBuffer } from "./e2ee/encoding";
import { assertOrThrow, E2EEError } from "./e2ee/errors";
import { getWebCrypto, randomBytes } from "./e2ee/runtime";

const AES_KEY_LENGTH = 256;
const LEGACY_IV_LENGTH = 12;

export * from "./e2ee/index";

export function isE2EEEnabled(): boolean {
  const raw = String(import.meta.env.VITE_CHAT_E2EE_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Legacy helper kept only for backward compatibility with old payloads.
 * New E2EE flow must use per-device sessions from src/services/crypto/e2ee/* modules.
 */
export async function generateConversationKey(options?: { extractable?: boolean }): Promise<CryptoKey> {
  return getWebCrypto().subtle.generateKey(
    {
      name: "AES-GCM",
      length: AES_KEY_LENGTH,
    },
    options?.extractable === true,
    ["encrypt", "decrypt"],
  );
}

/**
 * Legacy helper kept only for compatibility with old imports/exports.
 */
export async function exportConversationKey(key: CryptoKey): Promise<string> {
  assertOrThrow(key.extractable, "missing_key_material", "Legacy conversation key is not exportable.");
  const raw = await getWebCrypto().subtle.exportKey("raw", key);
  return bytesToBase64(new Uint8Array(raw));
}

/**
 * Legacy helper kept only for compatibility with old imports/exports.
 */
export async function importConversationKey(base64: string): Promise<CryptoKey> {
  const bytes = base64ToBytes(base64, {
    label: "legacy conversation key",
    expectedLength: 32,
  });

  return getWebCrypto().subtle.importKey(
    "raw",
    toArrayBuffer(bytes),
    {
      name: "AES-GCM",
      length: AES_KEY_LENGTH,
    },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Legacy message encryption path.
 * New code should use session-based envelopes from message.ts.
 */
export async function encryptMessage(key: CryptoKey, plainText: string): Promise<{ ivBase64: string; cipherTextBase64: string }> {
  const iv = randomBytes(LEGACY_IV_LENGTH);
  const encoded = new TextEncoder().encode(String(plainText ?? ""));

  let cipherBuffer: ArrayBuffer;
  try {
    cipherBuffer = await getWebCrypto().subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(iv),
      },
      key,
      toArrayBuffer(encoded),
    );
  } catch (error) {
    throw new E2EEError("invalid_payload", "Legacy encryptMessage failed.", {
      cause: error,
    });
  }

  return {
    ivBase64: bytesToBase64(iv),
    cipherTextBase64: bytesToBase64(new Uint8Array(cipherBuffer)),
  };
}

/**
 * Legacy message decryption path.
 * New code should use session-based envelopes from message.ts.
 */
export async function decryptMessage(key: CryptoKey, ivBase64: string, cipherTextBase64: string): Promise<string> {
  const iv = base64ToBytes(ivBase64, {
    label: "legacy iv",
    expectedLength: LEGACY_IV_LENGTH,
  });
  const cipher = base64ToBytes(cipherTextBase64, {
    label: "legacy ciphertext",
  });

  let plainBuffer: ArrayBuffer;
  try {
    plainBuffer = await getWebCrypto().subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(iv),
      },
      key,
      toArrayBuffer(cipher),
    );
  } catch (error) {
    throw new E2EEError("decrypt_failed", "Legacy decryptMessage failed.", {
      cause: error,
    });
  }

  return new TextDecoder().decode(plainBuffer);
}
