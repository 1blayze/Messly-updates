export const E2EE_ENVELOPE_VERSION = 2 as const;
export const E2EE_PROTOCOL_ALGORITHM = "MESSLY_X3DH_P256_DR_AES256GCM_SHA256_V2" as const;
export const E2EE_LEGACY_ENVELOPE_VERSION = 1 as const;
export const MAX_SKIPPED_MESSAGE_KEYS = 512;
export const MAX_REPLAY_FINGERPRINTS = 2048;

export type E2EEEnvelopeVersion = typeof E2EE_ENVELOPE_VERSION;
export type E2EEAlgorithm = typeof E2EE_PROTOCOL_ALGORITHM;

export interface DevicePublicIdentity {
  userId: string;
  deviceId: string;
  identityDhPublicKey: string;
  identitySigningPublicKey: string;
  keyAgreementAlgorithm: "ECDH-P256";
  signingAlgorithm: "ECDSA-P256-SHA256";
  createdAt: string;
}

export interface DeviceIdentityRecord {
  userId: string;
  deviceId: string;
  createdAt: string;
  identityDhKeyPair: CryptoKeyPair;
  identitySigningKeyPair: CryptoKeyPair;
}

export interface SignedPreKeyRecord {
  preKeyId: string;
  createdAt: string;
  expiresAt: string;
  keyPair: CryptoKeyPair;
  publicKey: string;
  signature: string;
}

export interface OneTimePreKeyRecord {
  preKeyId: string;
  createdAt: string;
  keyPair: CryptoKeyPair;
  publicKey: string;
  consumedAt: string | null;
}

export interface SignedPreKeyPublicBundle {
  preKeyId: string;
  publicKey: string;
  signature: string;
  createdAt: string;
  expiresAt: string;
}

export interface OneTimePreKeyPublicBundle {
  preKeyId: string;
  publicKey: string;
  createdAt: string;
}

export interface DevicePreKeyBundle {
  bundleId: string;
  issuedAt: string;
  identity: DevicePublicIdentity;
  signedPreKey: SignedPreKeyPublicBundle;
  oneTimePreKey?: OneTimePreKeyPublicBundle;
}

export interface SessionInitEnvelope {
  version: E2EEEnvelopeVersion;
  envelopeType: "session_init";
  algorithm: E2EEAlgorithm;
  conversationId: string;
  sessionId: string;
  senderUserId: string;
  senderDeviceId: string;
  recipientUserId: string;
  recipientDeviceId: string;
  senderIdentityDhPublicKey: string;
  senderIdentitySigningPublicKey: string;
  senderEphemeralPublicKey: string;
  recipientSignedPreKeyId: string;
  recipientOneTimePreKeyId?: string;
  createdAt: string;
  signature: string;
}

export interface SessionMessageEnvelopeV2 {
  version: E2EEEnvelopeVersion;
  envelopeType: "message";
  algorithm: E2EEAlgorithm;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  recipientUserId: string;
  recipientDeviceId: string;
  sessionId: string;
  messageIndex: number;
  previousChainLength: number;
  ratchetPublicKey: string;
  iv: string;
  ciphertext: string;
  associatedDataHash: string;
  signature: string;
  createdAt: string;
}

export interface LegacyMessageEnvelopeV1 {
  version: typeof E2EE_LEGACY_ENVELOPE_VERSION;
  envelopeType: "legacy_message";
  ivBase64: string;
  cipherTextBase64: string;
}

export type AnyE2EEEnvelope = SessionInitEnvelope | SessionMessageEnvelopeV2 | LegacyMessageEnvelopeV1;

export interface DoubleRatchetSession {
  version: E2EEEnvelopeVersion;
  algorithm: E2EEAlgorithm;
  sessionId: string;
  conversationId: string;
  localUserId: string;
  localDeviceId: string;
  remoteUserId: string;
  remoteDeviceId: string;
  rootKey: Uint8Array;
  sendingChainKey: Uint8Array;
  receivingChainKey: Uint8Array;
  sendingMessageIndex: number;
  receivingMessageIndex: number;
  previousSendingChainLength: number;
  localRatchetKeyPair: CryptoKeyPair;
  remoteRatchetPublicKey: CryptoKey;
  remoteRatchetPublicKeyBase64: string;
  localIdentitySigningPrivateKey: CryptoKey;
  remoteIdentitySigningPublicKey: CryptoKey;
  skippedMessageKeys: Map<number, { messageKey: Uint8Array; iv: Uint8Array }>;
  replayFingerprints: Set<string>;
  requireRatchetKeyInNextMessage: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SessionDecryptResult {
  plainText: string;
  messageIndex: number;
}

export interface SessionBootstrapResult {
  session: DoubleRatchetSession;
  initEnvelope: SessionInitEnvelope;
}

export interface SessionFanoutEnvelope {
  recipientUserId: string;
  recipientDeviceId: string;
  envelope: SessionMessageEnvelopeV2;
}

export interface SessionDecryptInput {
  envelope: SessionMessageEnvelopeV2;
}

export type MembershipChangeReason = "member_added" | "member_removed" | "device_added" | "device_revoked";

export interface MembershipRekeyPlan {
  conversationId: string;
  reason: MembershipChangeReason;
  rekeyDeviceIds: string[];
  generatedAt: string;
}
