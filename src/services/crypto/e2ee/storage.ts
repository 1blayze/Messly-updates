import {
  exportPrivateKeyPkcs8,
  exportPublicKeySpki,
  importAesGcmKey,
  importEcdhPrivateKeyPkcs8,
  importEcdhPublicKeySpki,
  importEcdsaPrivateKeyPkcs8,
  importEcdsaPublicKeySpki,
} from "./algorithms";
import { base64ToBytes, bytesToBase64, toArrayBuffer, utf8ToBytes } from "./encoding";
import { assertOrThrow, E2EEError } from "./errors";
import { sha256 } from "./kdf";
import { getWebCrypto, randomBytes } from "./runtime";
import type { DeviceIdentityRecord, DoubleRatchetSession } from "./types";

const WRAPPING_IV_LENGTH = 12;
const WRAPPING_SECRET_BYTES = 32;

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export class InMemoryKeyValueStore implements KeyValueStore {
  private readonly storage = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.storage.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.storage.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.storage.delete(key);
  }
}

export interface WrappedBinaryBlob {
  algorithm: "AES-GCM";
  iv: string;
  ciphertext: string;
}

export interface WrappedPrivateKeyRecord {
  format: "pkcs8";
  wrapped: WrappedBinaryBlob;
}

export interface PersistedDeviceIdentityRecord {
  userId: string;
  deviceId: string;
  createdAt: string;
  identityDhPublicKey: string;
  identityDhPrivateKey: WrappedPrivateKeyRecord;
  identitySigningPublicKey: string;
  identitySigningPrivateKey: WrappedPrivateKeyRecord;
}

export interface PersistedSkippedMessageKeyRecord {
  messageIndex: number;
  messageKey: string;
  iv: string;
}

export interface PersistedSessionRecord {
  version: number;
  algorithm: string;
  sessionId: string;
  conversationId: string;
  localUserId: string;
  localDeviceId: string;
  remoteUserId: string;
  remoteDeviceId: string;
  rootKey: string;
  sendingChainKey: string;
  receivingChainKey: string;
  sendingMessageIndex: number;
  receivingMessageIndex: number;
  previousSendingChainLength: number;
  localRatchetPublicKey: string;
  localRatchetPrivateKey: WrappedPrivateKeyRecord;
  remoteRatchetPublicKey: string;
  localIdentitySigningPrivateKey: WrappedPrivateKeyRecord;
  remoteIdentitySigningPublicKey: string;
  skippedMessageKeys: PersistedSkippedMessageKeyRecord[];
  replayFingerprints: string[];
  requireRatchetKeyInNextMessage: boolean;
  createdAt: string;
  updatedAt: string;
}

async function encryptWithWrappingKey(wrappingKey: CryptoKey, plaintext: Uint8Array): Promise<WrappedBinaryBlob> {
  const iv = randomBytes(WRAPPING_IV_LENGTH);
  const ciphertext = await getWebCrypto().subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
    },
    wrappingKey,
    toArrayBuffer(plaintext),
  );
  return {
    algorithm: "AES-GCM",
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptWithWrappingKey(wrappingKey: CryptoKey, wrapped: WrappedBinaryBlob): Promise<Uint8Array> {
  const iv = base64ToBytes(wrapped.iv, {
    label: "wrapped key iv",
    expectedLength: WRAPPING_IV_LENGTH,
  });
  const ciphertext = base64ToBytes(wrapped.ciphertext, {
    label: "wrapped key ciphertext",
  });
  try {
    const plaintext = await getWebCrypto().subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(iv),
      },
      wrappingKey,
      toArrayBuffer(ciphertext),
    );
    return new Uint8Array(plaintext);
  } catch (error) {
    throw new E2EEError("decrypt_failed", "Failed to unwrap persisted key material.", {
      cause: error,
    });
  }
}

export async function createWrappingKeyFromSecret(secret: Uint8Array | string): Promise<CryptoKey> {
  const secretBytes = typeof secret === "string" ? utf8ToBytes(secret) : secret;
  const digest = await sha256(secretBytes);
  return importAesGcmKey(digest.slice(0, 32), ["encrypt", "decrypt"]);
}

export async function getOrCreateWrappingSecret(store: KeyValueStore, key = "messly:e2ee:wrapping-secret:v1"): Promise<string> {
  const existing = await store.get(key);
  if (existing && existing.trim().length > 0) {
    return existing.trim();
  }
  const created = bytesToBase64(randomBytes(WRAPPING_SECRET_BYTES));
  await store.set(key, created);
  return created;
}

export async function getOrCreateWrappingKey(store: KeyValueStore, key?: string): Promise<CryptoKey> {
  const secretBase64 = await getOrCreateWrappingSecret(store, key);
  return createWrappingKeyFromSecret(base64ToBytes(secretBase64, {
    label: "wrapping secret",
    expectedLength: WRAPPING_SECRET_BYTES,
  }));
}

export async function wrapPrivateKeyPkcs8(privateKey: CryptoKey, wrappingKey: CryptoKey): Promise<WrappedPrivateKeyRecord> {
  const pkcs8Base64 = await exportPrivateKeyPkcs8(privateKey);
  const wrapped = await encryptWithWrappingKey(
    wrappingKey,
    base64ToBytes(pkcs8Base64, {
      label: "pkcs8 private key",
    }),
  );
  return {
    format: "pkcs8",
    wrapped,
  };
}

export async function unwrapEcdhPrivateKey(record: WrappedPrivateKeyRecord, wrappingKey: CryptoKey): Promise<CryptoKey> {
  assertOrThrow(record.format === "pkcs8", "invalid_payload", "Unsupported wrapped private key format.");
  const pkcs8 = await decryptWithWrappingKey(wrappingKey, record.wrapped);
  return importEcdhPrivateKeyPkcs8(bytesToBase64(pkcs8), false);
}

export async function unwrapEcdsaPrivateKey(record: WrappedPrivateKeyRecord, wrappingKey: CryptoKey): Promise<CryptoKey> {
  assertOrThrow(record.format === "pkcs8", "invalid_payload", "Unsupported wrapped private key format.");
  const pkcs8 = await decryptWithWrappingKey(wrappingKey, record.wrapped);
  return importEcdsaPrivateKeyPkcs8(bytesToBase64(pkcs8), false);
}

export async function serializeDeviceIdentity(identity: DeviceIdentityRecord, wrappingKey: CryptoKey): Promise<PersistedDeviceIdentityRecord> {
  return {
    userId: identity.userId,
    deviceId: identity.deviceId,
    createdAt: identity.createdAt,
    identityDhPublicKey: await exportPublicKeySpki(identity.identityDhKeyPair.publicKey),
    identityDhPrivateKey: await wrapPrivateKeyPkcs8(identity.identityDhKeyPair.privateKey, wrappingKey),
    identitySigningPublicKey: await exportPublicKeySpki(identity.identitySigningKeyPair.publicKey),
    identitySigningPrivateKey: await wrapPrivateKeyPkcs8(identity.identitySigningKeyPair.privateKey, wrappingKey),
  };
}

export async function deserializeDeviceIdentity(record: PersistedDeviceIdentityRecord, wrappingKey: CryptoKey): Promise<DeviceIdentityRecord> {
  const identityDhPrivateKey = await unwrapEcdhPrivateKey(record.identityDhPrivateKey, wrappingKey);
  const identitySigningPrivateKey = await unwrapEcdsaPrivateKey(record.identitySigningPrivateKey, wrappingKey);
  const identityDhPublicKey = await importEcdhPublicKeySpki(record.identityDhPublicKey);
  const identitySigningPublicKey = await importEcdsaPublicKeySpki(record.identitySigningPublicKey);
  return {
    userId: record.userId,
    deviceId: record.deviceId,
    createdAt: record.createdAt,
    identityDhKeyPair: {
      publicKey: identityDhPublicKey,
      privateKey: identityDhPrivateKey,
    },
    identitySigningKeyPair: {
      publicKey: identitySigningPublicKey,
      privateKey: identitySigningPrivateKey,
    },
  };
}

export async function serializeSession(session: DoubleRatchetSession, wrappingKey: CryptoKey): Promise<PersistedSessionRecord> {
  const localRatchetPublicKey = await exportPublicKeySpki(session.localRatchetKeyPair.publicKey);
  return {
    version: session.version,
    algorithm: session.algorithm,
    sessionId: session.sessionId,
    conversationId: session.conversationId,
    localUserId: session.localUserId,
    localDeviceId: session.localDeviceId,
    remoteUserId: session.remoteUserId,
    remoteDeviceId: session.remoteDeviceId,
    rootKey: bytesToBase64(session.rootKey),
    sendingChainKey: bytesToBase64(session.sendingChainKey),
    receivingChainKey: bytesToBase64(session.receivingChainKey),
    sendingMessageIndex: session.sendingMessageIndex,
    receivingMessageIndex: session.receivingMessageIndex,
    previousSendingChainLength: session.previousSendingChainLength,
    localRatchetPublicKey,
    localRatchetPrivateKey: await wrapPrivateKeyPkcs8(session.localRatchetKeyPair.privateKey, wrappingKey),
    remoteRatchetPublicKey: session.remoteRatchetPublicKeyBase64,
    localIdentitySigningPrivateKey: await wrapPrivateKeyPkcs8(session.localIdentitySigningPrivateKey, wrappingKey),
    remoteIdentitySigningPublicKey: await exportPublicKeySpki(session.remoteIdentitySigningPublicKey),
    skippedMessageKeys: [...session.skippedMessageKeys.entries()]
      .map(([messageIndex, value]) => ({
        messageIndex,
        messageKey: bytesToBase64(value.messageKey),
        iv: bytesToBase64(value.iv),
      }))
      .sort((left, right) => left.messageIndex - right.messageIndex),
    replayFingerprints: [...session.replayFingerprints.values()],
    requireRatchetKeyInNextMessage: session.requireRatchetKeyInNextMessage,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export async function deserializeSession(record: PersistedSessionRecord, wrappingKey: CryptoKey): Promise<DoubleRatchetSession> {
  const localRatchetPrivateKey = await unwrapEcdhPrivateKey(record.localRatchetPrivateKey, wrappingKey);
  const localRatchetPublicKey = await importEcdhPublicKeySpki(record.localRatchetPublicKey);
  const remoteRatchetPublicKey = await importEcdhPublicKeySpki(record.remoteRatchetPublicKey);
  const localIdentitySigningPrivateKey = await unwrapEcdsaPrivateKey(record.localIdentitySigningPrivateKey, wrappingKey);
  const remoteIdentitySigningPublicKey = await importEcdsaPublicKeySpki(record.remoteIdentitySigningPublicKey);
  return {
    version: record.version as DoubleRatchetSession["version"],
    algorithm: record.algorithm as DoubleRatchetSession["algorithm"],
    sessionId: record.sessionId,
    conversationId: record.conversationId,
    localUserId: record.localUserId,
    localDeviceId: record.localDeviceId,
    remoteUserId: record.remoteUserId,
    remoteDeviceId: record.remoteDeviceId,
    rootKey: base64ToBytes(record.rootKey, {
      label: "session root key",
      expectedLength: 32,
    }),
    sendingChainKey: base64ToBytes(record.sendingChainKey, {
      label: "session sending chain key",
      expectedLength: 32,
    }),
    receivingChainKey: base64ToBytes(record.receivingChainKey, {
      label: "session receiving chain key",
      expectedLength: 32,
    }),
    sendingMessageIndex: record.sendingMessageIndex,
    receivingMessageIndex: record.receivingMessageIndex,
    previousSendingChainLength: record.previousSendingChainLength,
    localRatchetKeyPair: {
      publicKey: localRatchetPublicKey,
      privateKey: localRatchetPrivateKey,
    },
    remoteRatchetPublicKey,
    remoteRatchetPublicKeyBase64: record.remoteRatchetPublicKey,
    localIdentitySigningPrivateKey,
    remoteIdentitySigningPublicKey,
    skippedMessageKeys: new Map<number, { messageKey: Uint8Array; iv: Uint8Array }>(
      record.skippedMessageKeys.map((entry) => [
        entry.messageIndex,
        {
          messageKey: base64ToBytes(entry.messageKey, {
            label: `skipped message key ${entry.messageIndex}`,
            expectedLength: 32,
          }),
          iv: base64ToBytes(entry.iv, {
            label: `skipped iv ${entry.messageIndex}`,
            expectedLength: 12,
          }),
        },
      ]),
    ),
    replayFingerprints: new Set(record.replayFingerprints),
    requireRatchetKeyInNextMessage: record.requireRatchetKeyInNextMessage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
