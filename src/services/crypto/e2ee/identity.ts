import {
  exportPublicKeySpki,
  generateEcdhKeyPair,
  generateEcdsaKeyPair,
  importEcdsaPublicKeySpki,
  signWithEcdsa,
  signatureBase64ToBytes,
  verifyWithEcdsa,
} from "./algorithms";
import { bytesToBase64, toArrayBuffer, utf8ToBytes } from "./encoding";
import { assertOrThrow, E2EEError } from "./errors";
import { getWebCrypto, randomId } from "./runtime";
import type { DeviceIdentityRecord, DevicePublicIdentity } from "./types";

export interface CreateDeviceIdentityInput {
  userId: string;
  deviceId?: string;
  createdAt?: string;
  extractable?: boolean;
}

export interface DeviceIdentityFingerprint {
  userId: string;
  deviceId: string;
  fingerprint: string;
}

export async function createDeviceIdentity(input: CreateDeviceIdentityInput): Promise<DeviceIdentityRecord> {
  const userId = String(input.userId ?? "").trim();
  assertOrThrow(userId.length > 0, "invalid_argument", "userId is required for device identity.");

  const deviceId = String(input.deviceId ?? "").trim() || randomId("device");
  const createdAt = input.createdAt ?? new Date().toISOString();
  const extractable = input.extractable === true;
  const [identityDhKeyPair, identitySigningKeyPair] = await Promise.all([
    generateEcdhKeyPair({
      extractable,
    }),
    generateEcdsaKeyPair({
      extractable,
    }),
  ]);

  return {
    userId,
    deviceId,
    createdAt,
    identityDhKeyPair,
    identitySigningKeyPair,
  };
}

export async function toDevicePublicIdentity(record: DeviceIdentityRecord): Promise<DevicePublicIdentity> {
  return {
    userId: record.userId,
    deviceId: record.deviceId,
    identityDhPublicKey: await exportPublicKeySpki(record.identityDhKeyPair.publicKey),
    identitySigningPublicKey: await exportPublicKeySpki(record.identitySigningKeyPair.publicKey),
    keyAgreementAlgorithm: "ECDH-P256",
    signingAlgorithm: "ECDSA-P256-SHA256",
    createdAt: record.createdAt,
  };
}

function toIdentityProofBytes(payload: string, userId: string, deviceId: string): Uint8Array {
  return utf8ToBytes([userId, deviceId, payload].map((value) => JSON.stringify(value)).join("\n"));
}

export async function signIdentityPayload(
  identity: DeviceIdentityRecord,
  payload: string,
): Promise<string> {
  const bytes = toIdentityProofBytes(payload, identity.userId, identity.deviceId);
  const signature = await signWithEcdsa(identity.identitySigningKeyPair.privateKey, bytes);
  return bytesToBase64(signature);
}

export async function verifyIdentityPayloadSignature(input: {
  payload: string;
  signature: string;
  publicIdentity: DevicePublicIdentity;
}): Promise<boolean> {
  const bytes = toIdentityProofBytes(input.payload, input.publicIdentity.userId, input.publicIdentity.deviceId);
  const signature = signatureBase64ToBytes(input.signature);
  const publicKey = await importEcdsaPublicKeySpki(input.publicIdentity.identitySigningPublicKey);
  return verifyWithEcdsa(publicKey, signature, bytes);
}

export async function createIdentityFingerprint(identity: DevicePublicIdentity): Promise<DeviceIdentityFingerprint> {
  try {
    const normalized = [
      identity.userId,
      identity.deviceId,
      identity.identityDhPublicKey,
      identity.identitySigningPublicKey,
      identity.createdAt,
    ].join("|");
    const digest = await getWebCrypto().subtle.digest("SHA-256", toArrayBuffer(utf8ToBytes(normalized)));
    return {
      userId: identity.userId,
      deviceId: identity.deviceId,
      fingerprint: bytesToBase64(new Uint8Array(digest)),
    };
  } catch (error) {
    throw new E2EEError("invalid_payload", "Failed to compute device fingerprint.", {
      cause: error,
    });
  }
}

export async function importRemoteSigningKey(identity: DevicePublicIdentity): Promise<CryptoKey> {
  return importEcdsaPublicKeySpki(identity.identitySigningPublicKey);
}
