import {
  exportPublicKeySpki,
  generateEcdhKeyPair,
  importEcdsaPublicKeySpki,
  signWithEcdsa,
  signatureBase64ToBytes,
  verifyWithEcdsa,
} from "./algorithms";
import { bytesToBase64, utf8ToBytes } from "./encoding";
import { assertOrThrow } from "./errors";
import { randomId } from "./runtime";
import type {
  DevicePreKeyBundle,
  DevicePublicIdentity,
  OneTimePreKeyRecord,
  SignedPreKeyRecord,
} from "./types";

const DEFAULT_SIGNED_PREKEY_TTL_DAYS = 30;

function buildSignedPreKeySignaturePayload(input: {
  userId: string;
  deviceId: string;
  preKeyId: string;
  publicKey: string;
  createdAt: string;
  expiresAt: string;
}): Uint8Array {
  return utf8ToBytes(
    [
      "messly:e2ee:signed-prekey:v2",
      input.userId,
      input.deviceId,
      input.preKeyId,
      input.publicKey,
      input.createdAt,
      input.expiresAt,
    ]
      .map((value) => JSON.stringify(value))
      .join("\n"),
  );
}

export interface CreateSignedPreKeyInput {
  userId: string;
  deviceId: string;
  identitySigningPrivateKey: CryptoKey;
  ttlDays?: number;
  extractable?: boolean;
  createdAt?: string;
}

export async function createSignedPreKey(input: CreateSignedPreKeyInput): Promise<SignedPreKeyRecord> {
  const userId = String(input.userId ?? "").trim();
  const deviceId = String(input.deviceId ?? "").trim();
  assertOrThrow(userId.length > 0, "invalid_argument", "userId is required for signed prekey.");
  assertOrThrow(deviceId.length > 0, "invalid_argument", "deviceId is required for signed prekey.");

  const createdAt = input.createdAt ?? new Date().toISOString();
  const ttlDays = Number.isFinite(input.ttlDays) && Number(input.ttlDays) > 0 ? Number(input.ttlDays) : DEFAULT_SIGNED_PREKEY_TTL_DAYS;
  const expiresAt = new Date(Date.parse(createdAt) + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const keyPair = await generateEcdhKeyPair({
    extractable: input.extractable === true,
  });
  const preKeyId = randomId("spk");
  const publicKey = await exportPublicKeySpki(keyPair.publicKey);
  const payload = buildSignedPreKeySignaturePayload({
    userId,
    deviceId,
    preKeyId,
    publicKey,
    createdAt,
    expiresAt,
  });
  const signature = bytesToBase64(await signWithEcdsa(input.identitySigningPrivateKey, payload));
  return {
    preKeyId,
    createdAt,
    expiresAt,
    keyPair,
    publicKey,
    signature,
  };
}

export interface CreateOneTimePreKeysInput {
  count: number;
  createdAt?: string;
  extractable?: boolean;
}

export async function createOneTimePreKeys(input: CreateOneTimePreKeysInput): Promise<OneTimePreKeyRecord[]> {
  const count = Math.floor(input.count);
  assertOrThrow(count > 0 && count <= 256, "invalid_argument", "One-time prekey count must be between 1 and 256.");
  const createdAt = input.createdAt ?? new Date().toISOString();
  const out: OneTimePreKeyRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const keyPair = await generateEcdhKeyPair({
      extractable: input.extractable === true,
    });
    out.push({
      preKeyId: randomId("opk"),
      createdAt,
      keyPair,
      publicKey: await exportPublicKeySpki(keyPair.publicKey),
      consumedAt: null,
    });
  }
  return out;
}

export async function createDevicePreKeyBundle(input: {
  identity: DevicePublicIdentity;
  signedPreKey: SignedPreKeyRecord;
  oneTimePreKey?: OneTimePreKeyRecord | null;
  issuedAt?: string;
}): Promise<DevicePreKeyBundle> {
  return {
    bundleId: randomId("bundle"),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    identity: input.identity,
    signedPreKey: {
      preKeyId: input.signedPreKey.preKeyId,
      publicKey: input.signedPreKey.publicKey,
      signature: input.signedPreKey.signature,
      createdAt: input.signedPreKey.createdAt,
      expiresAt: input.signedPreKey.expiresAt,
    },
    oneTimePreKey: input.oneTimePreKey
      ? {
          preKeyId: input.oneTimePreKey.preKeyId,
          publicKey: input.oneTimePreKey.publicKey,
          createdAt: input.oneTimePreKey.createdAt,
        }
      : undefined,
  };
}

export async function verifyDevicePreKeyBundle(bundle: DevicePreKeyBundle): Promise<boolean> {
  const now = Date.now();
  const expiresAt = Date.parse(bundle.signedPreKey.expiresAt);
  assertOrThrow(Number.isFinite(expiresAt), "invalid_payload", "Signed prekey expiration is invalid.");
  assertOrThrow(expiresAt > now, "missing_key_material", "Signed prekey is expired.");

  const payload = buildSignedPreKeySignaturePayload({
    userId: bundle.identity.userId,
    deviceId: bundle.identity.deviceId,
    preKeyId: bundle.signedPreKey.preKeyId,
    publicKey: bundle.signedPreKey.publicKey,
    createdAt: bundle.signedPreKey.createdAt,
    expiresAt: bundle.signedPreKey.expiresAt,
  });
  const signingPublicKey = await importEcdsaPublicKeySpki(bundle.identity.identitySigningPublicKey);
  const signature = signatureBase64ToBytes(bundle.signedPreKey.signature);
  return verifyWithEcdsa(signingPublicKey, signature, payload);
}

export function markOneTimePreKeyConsumed(preKeys: OneTimePreKeyRecord[], preKeyId: string, consumedAt?: string): void {
  const normalizedId = String(preKeyId ?? "").trim();
  if (!normalizedId) {
    return;
  }
  for (const preKey of preKeys) {
    if (preKey.preKeyId === normalizedId) {
      preKey.consumedAt = consumedAt ?? new Date().toISOString();
      break;
    }
  }
}

export function pickNextAvailableOneTimePreKey(preKeys: OneTimePreKeyRecord[]): OneTimePreKeyRecord | null {
  for (const preKey of preKeys) {
    if (!preKey.consumedAt) {
      return preKey;
    }
  }
  return null;
}
