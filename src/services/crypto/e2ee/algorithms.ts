import { assertOrThrow, E2EEError } from "./errors";
import { base64ToBytes, bytesToBase64, toArrayBuffer } from "./encoding";
import { getWebCrypto } from "./runtime";

const P256 = "P-256";
const AES_GCM = "AES-GCM";
const HMAC_SHA256 = "SHA-256";
const AES_KEY_LENGTH = 256;

export interface KeyGenerationOptions {
  extractable?: boolean;
}

function normalizeExtractable(options?: KeyGenerationOptions): boolean {
  return options?.extractable === true;
}

export async function generateEcdhKeyPair(options?: KeyGenerationOptions): Promise<CryptoKeyPair> {
  return getWebCrypto().subtle.generateKey(
    {
      name: "ECDH",
      namedCurve: P256,
    },
    normalizeExtractable(options),
    ["deriveBits", "deriveKey"],
  );
}

export async function generateEcdsaKeyPair(options?: KeyGenerationOptions): Promise<CryptoKeyPair> {
  return getWebCrypto().subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve: P256,
    },
    normalizeExtractable(options),
    ["sign", "verify"],
  );
}

export async function exportPublicKeySpki(publicKey: CryptoKey): Promise<string> {
  const exported = await getWebCrypto().subtle.exportKey("spki", publicKey);
  return bytesToBase64(new Uint8Array(exported));
}

export async function importEcdhPublicKeySpki(base64: string): Promise<CryptoKey> {
  const bytes = base64ToBytes(base64, {
    label: "ECDH SPKI public key",
  });
  return getWebCrypto().subtle.importKey(
    "spki",
    toArrayBuffer(bytes),
    {
      name: "ECDH",
      namedCurve: P256,
    },
    true,
    [],
  );
}

export async function importEcdsaPublicKeySpki(base64: string): Promise<CryptoKey> {
  const bytes = base64ToBytes(base64, {
    label: "ECDSA SPKI public key",
  });
  return getWebCrypto().subtle.importKey(
    "spki",
    toArrayBuffer(bytes),
    {
      name: "ECDSA",
      namedCurve: P256,
    },
    true,
    ["verify"],
  );
}

export async function exportPrivateKeyPkcs8(privateKey: CryptoKey): Promise<string> {
  assertOrThrow(privateKey.extractable, "missing_key_material", "Private key is not extractable.");
  const exported = await getWebCrypto().subtle.exportKey("pkcs8", privateKey);
  return bytesToBase64(new Uint8Array(exported));
}

export async function importEcdhPrivateKeyPkcs8(base64: string, extractable = false): Promise<CryptoKey> {
  const bytes = base64ToBytes(base64, {
    label: "ECDH PKCS8 private key",
  });
  return getWebCrypto().subtle.importKey(
    "pkcs8",
    toArrayBuffer(bytes),
    {
      name: "ECDH",
      namedCurve: P256,
    },
    extractable,
    ["deriveBits", "deriveKey"],
  );
}

export async function importEcdsaPrivateKeyPkcs8(base64: string, extractable = false): Promise<CryptoKey> {
  const bytes = base64ToBytes(base64, {
    label: "ECDSA PKCS8 private key",
  });
  return getWebCrypto().subtle.importKey(
    "pkcs8",
    toArrayBuffer(bytes),
    {
      name: "ECDSA",
      namedCurve: P256,
    },
    extractable,
    ["sign"],
  );
}

export async function deriveEcdhSharedSecret(privateKey: CryptoKey, publicKey: CryptoKey): Promise<Uint8Array> {
  try {
    const bits = await getWebCrypto().subtle.deriveBits(
      {
        name: "ECDH",
        public: publicKey,
      },
      privateKey,
      AES_KEY_LENGTH,
    );
    return new Uint8Array(bits);
  } catch (error) {
    throw new E2EEError("missing_key_material", "Failed to derive ECDH shared secret.", {
      cause: error,
    });
  }
}

export async function signWithEcdsa(privateKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  try {
    const signature = await getWebCrypto().subtle.sign(
      {
        name: "ECDSA",
        hash: HMAC_SHA256,
      },
      privateKey,
      toArrayBuffer(data),
    );
    return new Uint8Array(signature);
  } catch (error) {
    throw new E2EEError("invalid_signature", "Failed to sign payload with ECDSA.", {
      cause: error,
    });
  }
}

export async function verifyWithEcdsa(publicKey: CryptoKey, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  try {
    return await getWebCrypto().subtle.verify(
      {
        name: "ECDSA",
        hash: HMAC_SHA256,
      },
      publicKey,
      toArrayBuffer(signature),
      toArrayBuffer(data),
    );
  } catch (error) {
    throw new E2EEError("invalid_signature", "Failed to verify ECDSA signature.", {
      cause: error,
    });
  }
}

export async function importAesGcmKey(rawKey: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  assertOrThrow(rawKey.length === 32, "invalid_argument", "AES-256 key must be 32 bytes.", {
    actualLength: rawKey.length,
  });
  return getWebCrypto().subtle.importKey(
    "raw",
    toArrayBuffer(rawKey),
    {
      name: AES_GCM,
      length: AES_KEY_LENGTH,
    },
    false,
    usages,
  );
}

export async function encryptAesGcm(
  key: CryptoKey,
  plaintext: Uint8Array,
  iv: Uint8Array,
  additionalData?: Uint8Array,
): Promise<Uint8Array> {
  try {
    const encrypted = await getWebCrypto().subtle.encrypt(
      {
        name: AES_GCM,
        iv: toArrayBuffer(iv),
        additionalData: additionalData ? toArrayBuffer(additionalData) : undefined,
      },
      key,
      toArrayBuffer(plaintext),
    );
    return new Uint8Array(encrypted);
  } catch (error) {
    throw new E2EEError("invalid_payload", "Failed to encrypt payload with AES-GCM.", {
      cause: error,
    });
  }
}

export async function decryptAesGcm(
  key: CryptoKey,
  ciphertext: Uint8Array,
  iv: Uint8Array,
  additionalData?: Uint8Array,
): Promise<Uint8Array> {
  try {
    const decrypted = await getWebCrypto().subtle.decrypt(
      {
        name: AES_GCM,
        iv: toArrayBuffer(iv),
        additionalData: additionalData ? toArrayBuffer(additionalData) : undefined,
      },
      key,
      toArrayBuffer(ciphertext),
    );
    return new Uint8Array(decrypted);
  } catch (error) {
    throw new E2EEError("decrypt_failed", "Failed to decrypt AES-GCM payload.", {
      cause: error,
    });
  }
}

export function bytesToSignatureBase64(signature: Uint8Array): string {
  return bytesToBase64(signature);
}

export function signatureBase64ToBytes(signature: string): Uint8Array {
  return base64ToBytes(signature, {
    label: "signature",
  });
}
