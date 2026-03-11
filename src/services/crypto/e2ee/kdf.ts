import { assertOrThrow, E2EEError } from "./errors";
import { concatBytes, toArrayBuffer, toCryptoBytes, u32ToBytes } from "./encoding";
import { getWebCrypto } from "./runtime";

const HASH_SIZE = 32;

async function importHmacKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return getWebCrypto().subtle.importKey(
    "raw",
    toArrayBuffer(rawKey),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  try {
    const hmacKey = await importHmacKey(key);
    const signature = await getWebCrypto().subtle.sign("HMAC", hmacKey, toArrayBuffer(data));
    return new Uint8Array(signature);
  } catch (error) {
    throw new E2EEError("invalid_payload", "Failed to execute HMAC-SHA256.", {
      cause: error,
    });
  }
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  try {
    const digest = await getWebCrypto().subtle.digest("SHA-256", toArrayBuffer(data));
    return new Uint8Array(digest);
  } catch (error) {
    throw new E2EEError("invalid_payload", "Failed to execute SHA-256.", {
      cause: error,
    });
  }
}

export async function hkdfSha256(inputKeyMaterial: Uint8Array, salt: Uint8Array, info: Uint8Array, outputLength: number): Promise<Uint8Array> {
  assertOrThrow(outputLength > 0 && outputLength <= 255 * HASH_SIZE, "invalid_argument", "HKDF output length is out of range.", {
    details: {
      outputLength,
    },
  });

  const normalizedSalt = salt.length === 0 ? new Uint8Array(HASH_SIZE) : salt;
  const pseudoRandomKey = await hmacSha256(normalizedSalt, inputKeyMaterial);
  const blocks = Math.ceil(outputLength / HASH_SIZE);
  let previous: Uint8Array = new Uint8Array(0);
  const outputParts: Uint8Array[] = [];

  for (let counter = 1; counter <= blocks; counter += 1) {
    const input = concatBytes(previous, info, new Uint8Array([counter]));
    previous = await hmacSha256(pseudoRandomKey, input);
    outputParts.push(previous);
  }

  return toCryptoBytes(concatBytes(...outputParts).slice(0, outputLength));
}

export async function deriveChainStep(chainKey: Uint8Array, counter: number): Promise<{
  nextChainKey: Uint8Array;
  messageKey: Uint8Array;
  iv: Uint8Array;
}> {
  const counterBytes = u32ToBytes(counter);
  const nextChainKey = await hmacSha256(chainKey, concatBytes(new Uint8Array([0x01]), counterBytes));
  const messageMaterial = await hmacSha256(chainKey, concatBytes(new Uint8Array([0x02]), counterBytes));
  const messageKey = messageMaterial.slice(0, 32);
  const ivMaterial = await hmacSha256(chainKey, concatBytes(new Uint8Array([0x03]), counterBytes));
  const iv = ivMaterial.slice(0, 12);
  return {
    nextChainKey,
    messageKey,
    iv,
  };
}
