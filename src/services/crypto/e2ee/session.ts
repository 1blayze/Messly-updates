import {
  deriveEcdhSharedSecret,
  exportPublicKeySpki,
  generateEcdhKeyPair,
  importEcdhPublicKeySpki,
  importEcdsaPublicKeySpki,
  signWithEcdsa,
  signatureBase64ToBytes,
  verifyWithEcdsa,
} from "./algorithms";
import { bytesToBase64, concatBytes, utf8ToBytes } from "./encoding";
import { assertOrThrow } from "./errors";
import { hkdfSha256 } from "./kdf";
import { markOneTimePreKeyConsumed, verifyDevicePreKeyBundle } from "./prekeys";
import { randomId } from "./runtime";
import { buildSessionInitSignaturePayload } from "./serialization";
import {
  E2EE_ENVELOPE_VERSION,
  E2EE_PROTOCOL_ALGORITHM,
} from "./types";
import type {
  DeviceIdentityRecord,
  DevicePreKeyBundle,
  DevicePublicIdentity,
  DoubleRatchetSession,
  OneTimePreKeyRecord,
  SessionBootstrapResult,
  SessionInitEnvelope,
  SignedPreKeyRecord,
} from "./types";

const INITIAL_KEY_MATERIAL_LENGTH = 96;
const CHAIN_KEY_LENGTH = 32;

function normalizeIsoTimestamp(value?: string): string {
  return value ?? new Date().toISOString();
}

function assertConversationId(value: string): string {
  const normalized = String(value ?? "").trim();
  assertOrThrow(normalized.length > 0, "invalid_argument", "conversationId is required.");
  return normalized;
}

function buildInitialDeriveInfo(input: {
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  recipientUserId: string;
  recipientDeviceId: string;
  sessionId: string;
}): Uint8Array {
  return utf8ToBytes(
    [
      "messly:e2ee:x3dh:v2",
      input.conversationId,
      input.senderUserId,
      input.senderDeviceId,
      input.recipientUserId,
      input.recipientDeviceId,
      input.sessionId,
    ]
      .map((value) => JSON.stringify(value))
      .join("\n"),
  );
}

async function deriveInitialState(input: {
  sharedSecret: Uint8Array;
  deriveInfo: Uint8Array;
}): Promise<{
  rootKey: Uint8Array;
  chainForSender: Uint8Array;
  chainForRecipient: Uint8Array;
}> {
  const material = await hkdfSha256(
    input.sharedSecret,
    new Uint8Array(CHAIN_KEY_LENGTH),
    input.deriveInfo,
    INITIAL_KEY_MATERIAL_LENGTH,
  );
  return {
    rootKey: material.slice(0, CHAIN_KEY_LENGTH),
    chainForSender: material.slice(CHAIN_KEY_LENGTH, CHAIN_KEY_LENGTH * 2),
    chainForRecipient: material.slice(CHAIN_KEY_LENGTH * 2, CHAIN_KEY_LENGTH * 3),
  };
}

async function computeInitiatorSharedSecret(input: {
  localIdentityDhPrivateKey: CryptoKey;
  localEphemeralPrivateKey: CryptoKey;
  remoteIdentityDhPublicKey: CryptoKey;
  remoteSignedPreKeyPublicKey: CryptoKey;
  remoteOneTimePreKeyPublicKey?: CryptoKey;
}): Promise<Uint8Array> {
  const dh1 = await deriveEcdhSharedSecret(input.localIdentityDhPrivateKey, input.remoteSignedPreKeyPublicKey);
  const dh2 = await deriveEcdhSharedSecret(input.localEphemeralPrivateKey, input.remoteIdentityDhPublicKey);
  const dh3 = await deriveEcdhSharedSecret(input.localEphemeralPrivateKey, input.remoteSignedPreKeyPublicKey);
  if (input.remoteOneTimePreKeyPublicKey) {
    const dh4 = await deriveEcdhSharedSecret(input.localEphemeralPrivateKey, input.remoteOneTimePreKeyPublicKey);
    return concatBytes(dh1, dh2, dh3, dh4);
  }
  return concatBytes(dh1, dh2, dh3);
}

async function computeResponderSharedSecret(input: {
  localIdentityDhPrivateKey: CryptoKey;
  localSignedPreKeyPrivateKey: CryptoKey;
  localOneTimePreKeyPrivateKey?: CryptoKey;
  remoteIdentityDhPublicKey: CryptoKey;
  remoteEphemeralPublicKey: CryptoKey;
}): Promise<Uint8Array> {
  const dh1 = await deriveEcdhSharedSecret(input.localSignedPreKeyPrivateKey, input.remoteIdentityDhPublicKey);
  const dh2 = await deriveEcdhSharedSecret(input.localIdentityDhPrivateKey, input.remoteEphemeralPublicKey);
  const dh3 = await deriveEcdhSharedSecret(input.localSignedPreKeyPrivateKey, input.remoteEphemeralPublicKey);
  if (input.localOneTimePreKeyPrivateKey) {
    const dh4 = await deriveEcdhSharedSecret(input.localOneTimePreKeyPrivateKey, input.remoteEphemeralPublicKey);
    return concatBytes(dh1, dh2, dh3, dh4);
  }
  return concatBytes(dh1, dh2, dh3);
}

function createSessionBase(input: {
  conversationId: string;
  sessionId: string;
  localUserId: string;
  localDeviceId: string;
  remoteUserId: string;
  remoteDeviceId: string;
  rootKey: Uint8Array;
  sendingChainKey: Uint8Array;
  receivingChainKey: Uint8Array;
  localRatchetKeyPair: CryptoKeyPair;
  remoteRatchetPublicKey: CryptoKey;
  remoteRatchetPublicKeyBase64: string;
  localIdentitySigningPrivateKey: CryptoKey;
  remoteIdentitySigningPublicKey: CryptoKey;
  createdAt: string;
  requireRatchetKeyInNextMessage?: boolean;
}): DoubleRatchetSession {
  return {
    version: E2EE_ENVELOPE_VERSION,
    algorithm: E2EE_PROTOCOL_ALGORITHM,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    localUserId: input.localUserId,
    localDeviceId: input.localDeviceId,
    remoteUserId: input.remoteUserId,
    remoteDeviceId: input.remoteDeviceId,
    rootKey: input.rootKey,
    sendingChainKey: input.sendingChainKey,
    receivingChainKey: input.receivingChainKey,
    sendingMessageIndex: 0,
    receivingMessageIndex: 0,
    previousSendingChainLength: 0,
    localRatchetKeyPair: input.localRatchetKeyPair,
    remoteRatchetPublicKey: input.remoteRatchetPublicKey,
    remoteRatchetPublicKeyBase64: input.remoteRatchetPublicKeyBase64,
    localIdentitySigningPrivateKey: input.localIdentitySigningPrivateKey,
    remoteIdentitySigningPublicKey: input.remoteIdentitySigningPublicKey,
    skippedMessageKeys: new Map<number, { messageKey: Uint8Array; iv: Uint8Array }>(),
    replayFingerprints: new Set<string>(),
    requireRatchetKeyInNextMessage: input.requireRatchetKeyInNextMessage === true,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export interface InitiateSessionInput {
  conversationId: string;
  localIdentity: DeviceIdentityRecord;
  remoteBundle: DevicePreKeyBundle;
  sessionId?: string;
  createdAt?: string;
  expectedRemoteIdentity?: DevicePublicIdentity;
}

export async function initiateSession(input: InitiateSessionInput): Promise<SessionBootstrapResult> {
  const conversationId = assertConversationId(input.conversationId);
  const remoteBundleVerified = await verifyDevicePreKeyBundle(input.remoteBundle);
  assertOrThrow(remoteBundleVerified, "invalid_signature", "Remote prekey bundle signature is invalid.");

  if (input.expectedRemoteIdentity) {
    assertOrThrow(
      input.expectedRemoteIdentity.userId === input.remoteBundle.identity.userId &&
        input.expectedRemoteIdentity.deviceId === input.remoteBundle.identity.deviceId &&
        input.expectedRemoteIdentity.identityDhPublicKey === input.remoteBundle.identity.identityDhPublicKey &&
        input.expectedRemoteIdentity.identitySigningPublicKey === input.remoteBundle.identity.identitySigningPublicKey,
      "invalid_signature",
      "Remote identity does not match pinned identity.",
    );
  }

  const sessionId = String(input.sessionId ?? "").trim() || randomId("session");
  const createdAt = normalizeIsoTimestamp(input.createdAt);
  const senderEphemeralKeyPair = await generateEcdhKeyPair();
  const senderEphemeralPublicKey = await exportPublicKeySpki(senderEphemeralKeyPair.publicKey);

  const remoteIdentityDhPublicKey = await importEcdhPublicKeySpki(input.remoteBundle.identity.identityDhPublicKey);
  const remoteSignedPreKeyPublicKey = await importEcdhPublicKeySpki(input.remoteBundle.signedPreKey.publicKey);
  const remoteOneTimePreKeyPublicKey = input.remoteBundle.oneTimePreKey
    ? await importEcdhPublicKeySpki(input.remoteBundle.oneTimePreKey.publicKey)
    : undefined;

  const sharedSecret = await computeInitiatorSharedSecret({
    localIdentityDhPrivateKey: input.localIdentity.identityDhKeyPair.privateKey,
    localEphemeralPrivateKey: senderEphemeralKeyPair.privateKey,
    remoteIdentityDhPublicKey,
    remoteSignedPreKeyPublicKey,
    remoteOneTimePreKeyPublicKey,
  });

  const deriveInfo = buildInitialDeriveInfo({
    conversationId,
    senderUserId: input.localIdentity.userId,
    senderDeviceId: input.localIdentity.deviceId,
    recipientUserId: input.remoteBundle.identity.userId,
    recipientDeviceId: input.remoteBundle.identity.deviceId,
    sessionId,
  });
  const derived = await deriveInitialState({
    sharedSecret,
    deriveInfo,
  });

  const initEnvelopeWithoutSignature: Omit<SessionInitEnvelope, "signature"> = {
    version: E2EE_ENVELOPE_VERSION,
    envelopeType: "session_init",
    algorithm: E2EE_PROTOCOL_ALGORITHM,
    conversationId,
    sessionId,
    senderUserId: input.localIdentity.userId,
    senderDeviceId: input.localIdentity.deviceId,
    recipientUserId: input.remoteBundle.identity.userId,
    recipientDeviceId: input.remoteBundle.identity.deviceId,
    senderIdentityDhPublicKey: await exportPublicKeySpki(input.localIdentity.identityDhKeyPair.publicKey),
    senderIdentitySigningPublicKey: await exportPublicKeySpki(input.localIdentity.identitySigningKeyPair.publicKey),
    senderEphemeralPublicKey,
    recipientSignedPreKeyId: input.remoteBundle.signedPreKey.preKeyId,
    recipientOneTimePreKeyId: input.remoteBundle.oneTimePreKey?.preKeyId,
    createdAt,
  };
  const initSignature = await signWithEcdsa(
    input.localIdentity.identitySigningKeyPair.privateKey,
    buildSessionInitSignaturePayload(initEnvelopeWithoutSignature),
  );
  const initEnvelope: SessionInitEnvelope = {
    ...initEnvelopeWithoutSignature,
    signature: bytesToBase64(initSignature),
  };

  const remoteIdentitySigningPublicKey = await importEcdsaPublicKeySpki(input.remoteBundle.identity.identitySigningPublicKey);
  const session = createSessionBase({
    conversationId,
    sessionId,
    localUserId: input.localIdentity.userId,
    localDeviceId: input.localIdentity.deviceId,
    remoteUserId: input.remoteBundle.identity.userId,
    remoteDeviceId: input.remoteBundle.identity.deviceId,
    rootKey: derived.rootKey,
    sendingChainKey: derived.chainForSender,
    receivingChainKey: derived.chainForRecipient,
    localRatchetKeyPair: senderEphemeralKeyPair,
    remoteRatchetPublicKey: remoteSignedPreKeyPublicKey,
    remoteRatchetPublicKeyBase64: input.remoteBundle.signedPreKey.publicKey,
    localIdentitySigningPrivateKey: input.localIdentity.identitySigningKeyPair.privateKey,
    remoteIdentitySigningPublicKey,
    createdAt,
  });

  return {
    session,
    initEnvelope,
  };
}

export interface AcceptSessionInput {
  localIdentity: DeviceIdentityRecord;
  localSignedPreKey: SignedPreKeyRecord;
  localOneTimePreKeys?: OneTimePreKeyRecord[];
  initEnvelope: SessionInitEnvelope;
  expectedRemoteIdentity?: DevicePublicIdentity;
  acceptedAt?: string;
}

export interface AcceptSessionResult {
  session: DoubleRatchetSession;
  consumedOneTimePreKeyId?: string;
}

export async function acceptSession(input: AcceptSessionInput): Promise<AcceptSessionResult> {
  assertOrThrow(
    input.initEnvelope.recipientUserId === input.localIdentity.userId &&
      input.initEnvelope.recipientDeviceId === input.localIdentity.deviceId,
    "session_mismatch",
    "Session init envelope target device mismatch.",
  );
  assertOrThrow(
    input.initEnvelope.recipientSignedPreKeyId === input.localSignedPreKey.preKeyId,
    "missing_key_material",
    "Signed prekey does not match the session init envelope.",
  );

  if (input.expectedRemoteIdentity) {
    assertOrThrow(
      input.expectedRemoteIdentity.userId === input.initEnvelope.senderUserId &&
        input.expectedRemoteIdentity.deviceId === input.initEnvelope.senderDeviceId &&
        input.expectedRemoteIdentity.identityDhPublicKey === input.initEnvelope.senderIdentityDhPublicKey &&
        input.expectedRemoteIdentity.identitySigningPublicKey === input.initEnvelope.senderIdentitySigningPublicKey,
      "invalid_signature",
      "Sender identity key does not match pinned identity.",
    );
  }

  const initEnvelopeForSignature: Omit<SessionInitEnvelope, "signature"> = {
    version: input.initEnvelope.version,
    envelopeType: input.initEnvelope.envelopeType,
    algorithm: input.initEnvelope.algorithm,
    conversationId: input.initEnvelope.conversationId,
    sessionId: input.initEnvelope.sessionId,
    senderUserId: input.initEnvelope.senderUserId,
    senderDeviceId: input.initEnvelope.senderDeviceId,
    recipientUserId: input.initEnvelope.recipientUserId,
    recipientDeviceId: input.initEnvelope.recipientDeviceId,
    senderIdentityDhPublicKey: input.initEnvelope.senderIdentityDhPublicKey,
    senderIdentitySigningPublicKey: input.initEnvelope.senderIdentitySigningPublicKey,
    senderEphemeralPublicKey: input.initEnvelope.senderEphemeralPublicKey,
    recipientSignedPreKeyId: input.initEnvelope.recipientSignedPreKeyId,
    recipientOneTimePreKeyId: input.initEnvelope.recipientOneTimePreKeyId,
    createdAt: input.initEnvelope.createdAt,
  };

  const remoteSigningPublicKey = await importEcdsaPublicKeySpki(input.initEnvelope.senderIdentitySigningPublicKey);
  const signatureValid = await verifyWithEcdsa(
    remoteSigningPublicKey,
    signatureBase64ToBytes(input.initEnvelope.signature),
    buildSessionInitSignaturePayload(initEnvelopeForSignature),
  );
  assertOrThrow(signatureValid, "invalid_signature", "Session init envelope signature verification failed.");

  const localOneTimePreKeys = input.localOneTimePreKeys ?? [];
  let selectedOneTimePreKey: OneTimePreKeyRecord | undefined;
  if (input.initEnvelope.recipientOneTimePreKeyId) {
    selectedOneTimePreKey = localOneTimePreKeys.find((preKey) => preKey.preKeyId === input.initEnvelope.recipientOneTimePreKeyId);
    assertOrThrow(!!selectedOneTimePreKey, "missing_key_material", "One-time prekey referenced by envelope is not available.");
    assertOrThrow(!selectedOneTimePreKey.consumedAt, "missing_key_material", "One-time prekey already consumed.");
  }

  const remoteIdentityDhPublicKey = await importEcdhPublicKeySpki(input.initEnvelope.senderIdentityDhPublicKey);
  const remoteEphemeralPublicKey = await importEcdhPublicKeySpki(input.initEnvelope.senderEphemeralPublicKey);
  const sharedSecret = await computeResponderSharedSecret({
    localIdentityDhPrivateKey: input.localIdentity.identityDhKeyPair.privateKey,
    localSignedPreKeyPrivateKey: input.localSignedPreKey.keyPair.privateKey,
    localOneTimePreKeyPrivateKey: selectedOneTimePreKey?.keyPair.privateKey,
    remoteIdentityDhPublicKey,
    remoteEphemeralPublicKey,
  });

  const deriveInfo = buildInitialDeriveInfo({
    conversationId: input.initEnvelope.conversationId,
    senderUserId: input.initEnvelope.senderUserId,
    senderDeviceId: input.initEnvelope.senderDeviceId,
    recipientUserId: input.localIdentity.userId,
    recipientDeviceId: input.localIdentity.deviceId,
    sessionId: input.initEnvelope.sessionId,
  });
  const derived = await deriveInitialState({
    sharedSecret,
    deriveInfo,
  });

  const acceptedAt = normalizeIsoTimestamp(input.acceptedAt);
  const session = createSessionBase({
    conversationId: input.initEnvelope.conversationId,
    sessionId: input.initEnvelope.sessionId,
    localUserId: input.localIdentity.userId,
    localDeviceId: input.localIdentity.deviceId,
    remoteUserId: input.initEnvelope.senderUserId,
    remoteDeviceId: input.initEnvelope.senderDeviceId,
    rootKey: derived.rootKey,
    sendingChainKey: derived.chainForRecipient,
    receivingChainKey: derived.chainForSender,
    localRatchetKeyPair: input.localSignedPreKey.keyPair,
    remoteRatchetPublicKey: remoteEphemeralPublicKey,
    remoteRatchetPublicKeyBase64: input.initEnvelope.senderEphemeralPublicKey,
    localIdentitySigningPrivateKey: input.localIdentity.identitySigningKeyPair.privateKey,
    remoteIdentitySigningPublicKey: remoteSigningPublicKey,
    createdAt: acceptedAt,
    requireRatchetKeyInNextMessage: true,
  });

  if (selectedOneTimePreKey) {
    markOneTimePreKeyConsumed(localOneTimePreKeys, selectedOneTimePreKey.preKeyId, acceptedAt);
  }

  return {
    session,
    consumedOneTimePreKeyId: selectedOneTimePreKey?.preKeyId,
  };
}

export async function ratchetSessionForLocalRotation(session: DoubleRatchetSession): Promise<void> {
  const nextRatchetKeyPair = await generateEcdhKeyPair();
  const dhSecret = await deriveEcdhSharedSecret(nextRatchetKeyPair.privateKey, session.remoteRatchetPublicKey);
  const material = await hkdfSha256(
    dhSecret,
    session.rootKey,
    utf8ToBytes("messly:e2ee:double-ratchet:remote-recv:v2"),
    64,
  );
  session.rootKey = material.slice(0, 32);
  session.sendingChainKey = material.slice(32, 64);
  session.localRatchetKeyPair = nextRatchetKeyPair;
  session.previousSendingChainLength = session.sendingMessageIndex;
  session.sendingMessageIndex = 0;
  session.requireRatchetKeyInNextMessage = false;
  session.updatedAt = new Date().toISOString();
}

export async function ratchetSessionForRemoteRotation(
  session: DoubleRatchetSession,
  remoteRatchetPublicKeyBase64: string,
): Promise<void> {
  const remoteRatchetPublicKey = await importEcdhPublicKeySpki(remoteRatchetPublicKeyBase64);
  const receivingDhSecret = await deriveEcdhSharedSecret(session.localRatchetKeyPair.privateKey, remoteRatchetPublicKey);
  const receivingMaterial = await hkdfSha256(
    receivingDhSecret,
    session.rootKey,
    utf8ToBytes("messly:e2ee:double-ratchet:remote-recv:v2"),
    64,
  );
  const receivingRoot = receivingMaterial.slice(0, 32);
  const receivingChainKey = receivingMaterial.slice(32, 64);

  const nextLocalRatchetKeyPair = await generateEcdhKeyPair();
  const sendingDhSecret = await deriveEcdhSharedSecret(nextLocalRatchetKeyPair.privateKey, remoteRatchetPublicKey);
  const sendingMaterial = await hkdfSha256(
    sendingDhSecret,
    receivingRoot,
    utf8ToBytes("messly:e2ee:double-ratchet:remote-send:v2"),
    64,
  );

  session.rootKey = sendingMaterial.slice(0, 32);
  session.receivingChainKey = receivingChainKey;
  session.sendingChainKey = sendingMaterial.slice(32, 64);
  session.remoteRatchetPublicKey = remoteRatchetPublicKey;
  session.remoteRatchetPublicKeyBase64 = remoteRatchetPublicKeyBase64;
  session.localRatchetKeyPair = nextLocalRatchetKeyPair;
  session.receivingMessageIndex = 0;
  session.previousSendingChainLength = session.sendingMessageIndex;
  session.sendingMessageIndex = 0;
  session.requireRatchetKeyInNextMessage = false;
  session.updatedAt = new Date().toISOString();
}

export async function exportLocalRatchetPublicKey(session: DoubleRatchetSession): Promise<string> {
  return exportPublicKeySpki(session.localRatchetKeyPair.publicKey);
}

export function assertSessionEnvelopeContext(
  session: DoubleRatchetSession,
  envelope: {
    conversationId: string;
    sessionId: string;
    senderUserId: string;
    senderDeviceId: string;
    recipientUserId: string;
    recipientDeviceId: string;
  },
): void {
  assertOrThrow(session.conversationId === envelope.conversationId, "session_mismatch", "Conversation mismatch for encrypted envelope.");
  assertOrThrow(session.sessionId === envelope.sessionId, "session_mismatch", "Session mismatch for encrypted envelope.");
  assertOrThrow(
    session.remoteUserId === envelope.senderUserId && session.remoteDeviceId === envelope.senderDeviceId,
    "session_mismatch",
    "Envelope sender does not match remote device for this session.",
  );
  assertOrThrow(
    session.localUserId === envelope.recipientUserId && session.localDeviceId === envelope.recipientDeviceId,
    "session_mismatch",
    "Envelope recipient does not match local device for this session.",
  );
}

export function cloneSessionForRekey(session: DoubleRatchetSession): DoubleRatchetSession {
  return {
    ...session,
    sessionId: randomId("session"),
    rootKey: new Uint8Array(session.rootKey),
    sendingChainKey: new Uint8Array(session.sendingChainKey),
    receivingChainKey: new Uint8Array(session.receivingChainKey),
    skippedMessageKeys: new Map<number, { messageKey: Uint8Array; iv: Uint8Array }>(),
    replayFingerprints: new Set<string>(),
    sendingMessageIndex: 0,
    receivingMessageIndex: 0,
    previousSendingChainLength: 0,
    requireRatchetKeyInNextMessage: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function destroySessionMaterial(session: DoubleRatchetSession): void {
  session.rootKey.fill(0);
  session.sendingChainKey.fill(0);
  session.receivingChainKey.fill(0);
  session.skippedMessageKeys.clear();
  session.replayFingerprints.clear();
}
