import { base64ToBytes, bytesToBase64, toArrayBuffer, utf8ToBytes } from "./encoding";
import { assertOrThrow, E2EEError } from "./errors";
import { getWebCrypto } from "./runtime";
import {
  E2EE_ENVELOPE_VERSION,
  E2EE_LEGACY_ENVELOPE_VERSION,
  E2EE_PROTOCOL_ALGORITHM,
} from "./types";
import type {
  AnyE2EEEnvelope,
  LegacyMessageEnvelopeV1,
  SessionInitEnvelope,
  SessionMessageEnvelopeV2,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  assertOrThrow(typeof value === "string", "invalid_payload", `Envelope field "${key}" must be a string.`);
  const normalized = value.trim();
  assertOrThrow(normalized.length > 0, "invalid_payload", `Envelope field "${key}" cannot be empty.`);
  return normalized;
}

function getRequiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  assertOrThrow(typeof value === "number" && Number.isFinite(value), "invalid_payload", `Envelope field "${key}" must be a finite number.`);
  return value;
}

function toCanonicalBytes(values: unknown[]): Uint8Array {
  const normalized = values
    .map((value) => JSON.stringify(value))
    .join("\n");
  return utf8ToBytes(normalized);
}

export function buildSessionInitSignaturePayload(envelope: Omit<SessionInitEnvelope, "signature">): Uint8Array {
  return toCanonicalBytes([
    envelope.version,
    envelope.envelopeType,
    envelope.algorithm,
    envelope.conversationId,
    envelope.sessionId,
    envelope.senderUserId,
    envelope.senderDeviceId,
    envelope.recipientUserId,
    envelope.recipientDeviceId,
    envelope.senderIdentityDhPublicKey,
    envelope.senderIdentitySigningPublicKey,
    envelope.senderEphemeralPublicKey,
    envelope.recipientSignedPreKeyId,
    envelope.recipientOneTimePreKeyId ?? "",
    envelope.createdAt,
  ]);
}

export function buildSessionMessageAssociatedData(envelope: Omit<SessionMessageEnvelopeV2, "ciphertext" | "signature" | "associatedDataHash">): Uint8Array {
  return toCanonicalBytes([
    envelope.version,
    envelope.envelopeType,
    envelope.algorithm,
    envelope.conversationId,
    envelope.senderUserId,
    envelope.senderDeviceId,
    envelope.recipientUserId,
    envelope.recipientDeviceId,
    envelope.sessionId,
    envelope.messageIndex,
    envelope.previousChainLength,
    envelope.ratchetPublicKey,
    envelope.iv,
    envelope.createdAt,
  ]);
}

export function buildSessionMessageSignaturePayload(envelope: Omit<SessionMessageEnvelopeV2, "signature">): Uint8Array {
  return toCanonicalBytes([
    envelope.version,
    envelope.envelopeType,
    envelope.algorithm,
    envelope.conversationId,
    envelope.senderUserId,
    envelope.senderDeviceId,
    envelope.recipientUserId,
    envelope.recipientDeviceId,
    envelope.sessionId,
    envelope.messageIndex,
    envelope.previousChainLength,
    envelope.ratchetPublicKey,
    envelope.iv,
    envelope.ciphertext,
    envelope.associatedDataHash,
    envelope.createdAt,
  ]);
}

export async function createAssociatedDataHash(data: Uint8Array): Promise<string> {
  const digest = await getWebCrypto().subtle.digest("SHA-256", toArrayBuffer(data));
  return bytesToBase64(new Uint8Array(digest));
}

export function assertLegacyEnvelope(value: unknown): LegacyMessageEnvelopeV1 {
  assertOrThrow(isRecord(value), "invalid_payload", "Legacy envelope must be an object.");
  const version = getRequiredNumber(value, "version");
  assertOrThrow(version === E2EE_LEGACY_ENVELOPE_VERSION, "migration_unsupported", "Unsupported legacy envelope version.");
  const envelopeType = getRequiredString(value, "envelopeType");
  assertOrThrow(envelopeType === "legacy_message", "migration_unsupported", "Legacy envelope type is invalid.");
  const ivBase64 = getRequiredString(value, "ivBase64");
  const cipherTextBase64 = getRequiredString(value, "cipherTextBase64");
  base64ToBytes(ivBase64, {
    label: "legacy iv",
  });
  base64ToBytes(cipherTextBase64, {
    label: "legacy ciphertext",
  });
  return {
    version: E2EE_LEGACY_ENVELOPE_VERSION,
    envelopeType: "legacy_message",
    ivBase64,
    cipherTextBase64,
  };
}

export function assertSessionInitEnvelope(value: unknown): SessionInitEnvelope {
  assertOrThrow(isRecord(value), "invalid_payload", "Session init envelope must be an object.");
  const version = getRequiredNumber(value, "version");
  assertOrThrow(version === E2EE_ENVELOPE_VERSION, "migration_unsupported", "Unsupported E2EE envelope version.");
  const envelopeType = getRequiredString(value, "envelopeType");
  assertOrThrow(envelopeType === "session_init", "invalid_payload", "Envelope type is not session_init.");

  const algorithm = getRequiredString(value, "algorithm");
  assertOrThrow(algorithm === E2EE_PROTOCOL_ALGORITHM, "invalid_payload", "Envelope algorithm is invalid.");

  return {
    version: E2EE_ENVELOPE_VERSION,
    envelopeType: "session_init",
    algorithm: E2EE_PROTOCOL_ALGORITHM,
    conversationId: getRequiredString(value, "conversationId"),
    sessionId: getRequiredString(value, "sessionId"),
    senderUserId: getRequiredString(value, "senderUserId"),
    senderDeviceId: getRequiredString(value, "senderDeviceId"),
    recipientUserId: getRequiredString(value, "recipientUserId"),
    recipientDeviceId: getRequiredString(value, "recipientDeviceId"),
    senderIdentityDhPublicKey: getRequiredString(value, "senderIdentityDhPublicKey"),
    senderIdentitySigningPublicKey: getRequiredString(value, "senderIdentitySigningPublicKey"),
    senderEphemeralPublicKey: getRequiredString(value, "senderEphemeralPublicKey"),
    recipientSignedPreKeyId: getRequiredString(value, "recipientSignedPreKeyId"),
    recipientOneTimePreKeyId: typeof value.recipientOneTimePreKeyId === "string" && value.recipientOneTimePreKeyId.trim().length > 0
      ? value.recipientOneTimePreKeyId.trim()
      : undefined,
    createdAt: getRequiredString(value, "createdAt"),
    signature: getRequiredString(value, "signature"),
  };
}

export function assertSessionMessageEnvelope(value: unknown): SessionMessageEnvelopeV2 {
  assertOrThrow(isRecord(value), "invalid_payload", "Session message envelope must be an object.");
  const version = getRequiredNumber(value, "version");
  assertOrThrow(version === E2EE_ENVELOPE_VERSION, "migration_unsupported", "Unsupported E2EE envelope version.");
  const envelopeType = getRequiredString(value, "envelopeType");
  assertOrThrow(envelopeType === "message", "invalid_payload", "Envelope type is not message.");
  const algorithm = getRequiredString(value, "algorithm");
  assertOrThrow(algorithm === E2EE_PROTOCOL_ALGORITHM, "invalid_payload", "Envelope algorithm is invalid.");

  const messageIndex = getRequiredNumber(value, "messageIndex");
  const previousChainLength = getRequiredNumber(value, "previousChainLength");
  assertOrThrow(Number.isInteger(messageIndex) && messageIndex >= 0, "invalid_payload", "messageIndex must be a non-negative integer.");
  assertOrThrow(Number.isInteger(previousChainLength) && previousChainLength >= 0, "invalid_payload", "previousChainLength must be a non-negative integer.");

  const iv = getRequiredString(value, "iv");
  const ciphertext = getRequiredString(value, "ciphertext");
  const associatedDataHash = getRequiredString(value, "associatedDataHash");
  const signature = getRequiredString(value, "signature");

  base64ToBytes(iv, {
    label: "iv",
    expectedLength: 12,
  });
  base64ToBytes(ciphertext, {
    label: "ciphertext",
  });
  base64ToBytes(associatedDataHash, {
    label: "associatedDataHash",
    expectedLength: 32,
  });
  base64ToBytes(signature, {
    label: "signature",
  });

  return {
    version: E2EE_ENVELOPE_VERSION,
    envelopeType: "message",
    algorithm: E2EE_PROTOCOL_ALGORITHM,
    conversationId: getRequiredString(value, "conversationId"),
    senderUserId: getRequiredString(value, "senderUserId"),
    senderDeviceId: getRequiredString(value, "senderDeviceId"),
    recipientUserId: getRequiredString(value, "recipientUserId"),
    recipientDeviceId: getRequiredString(value, "recipientDeviceId"),
    sessionId: getRequiredString(value, "sessionId"),
    messageIndex,
    previousChainLength,
    ratchetPublicKey: getRequiredString(value, "ratchetPublicKey"),
    iv,
    ciphertext,
    associatedDataHash,
    signature,
    createdAt: getRequiredString(value, "createdAt"),
  };
}

export function deserializeEnvelope(raw: string): AnyE2EEEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new E2EEError("invalid_payload", "Failed to parse encrypted envelope JSON.", {
      cause: error,
    });
  }

  if (!isRecord(parsed)) {
    throw new E2EEError("invalid_payload", "Encrypted envelope payload must be an object.");
  }

  const envelopeType = typeof parsed.envelopeType === "string" ? parsed.envelopeType.trim() : "";
  if (envelopeType === "legacy_message") {
    return assertLegacyEnvelope(parsed);
  }
  if (envelopeType === "session_init") {
    return assertSessionInitEnvelope(parsed);
  }
  if (envelopeType === "message") {
    return assertSessionMessageEnvelope(parsed);
  }
  throw new E2EEError("invalid_payload", "Unknown envelopeType in encrypted payload.");
}

export function serializeEnvelope(envelope: AnyE2EEEnvelope): string {
  return JSON.stringify(envelope);
}
