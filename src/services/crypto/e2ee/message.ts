import {
  bytesToSignatureBase64,
  decryptAesGcm,
  encryptAesGcm,
  importAesGcmKey,
  signWithEcdsa,
  signatureBase64ToBytes,
  verifyWithEcdsa,
} from "./algorithms";
import { base64ToBytes, bytesEqual, bytesToBase64, bytesToUtf8, utf8ToBytes } from "./encoding";
import { assertOrThrow, E2EEError } from "./errors";
import { deriveChainStep } from "./kdf";
import {
  assertSessionEnvelopeContext,
  exportLocalRatchetPublicKey,
  ratchetSessionForLocalRotation,
  ratchetSessionForRemoteRotation,
} from "./session";
import {
  buildSessionMessageAssociatedData,
  buildSessionMessageSignaturePayload,
  createAssociatedDataHash,
} from "./serialization";
import {
  E2EE_ENVELOPE_VERSION,
  E2EE_PROTOCOL_ALGORITHM,
  MAX_REPLAY_FINGERPRINTS,
  MAX_SKIPPED_MESSAGE_KEYS,
} from "./types";
import type {
  DoubleRatchetSession,
  SessionDecryptResult,
  SessionMessageEnvelopeV2,
} from "./types";

function createReplayFingerprint(envelope: SessionMessageEnvelopeV2): string {
  return [
    envelope.sessionId,
    envelope.senderDeviceId,
    envelope.messageIndex,
    envelope.associatedDataHash,
    envelope.signature,
  ].join(":");
}

function trimReplayFingerprints(session: DoubleRatchetSession): void {
  if (session.replayFingerprints.size <= MAX_REPLAY_FINGERPRINTS) {
    return;
  }
  const iterator = session.replayFingerprints.values();
  while (session.replayFingerprints.size > MAX_REPLAY_FINGERPRINTS) {
    const next = iterator.next();
    if (next.done) {
      break;
    }
    session.replayFingerprints.delete(next.value);
  }
}

function trimSkippedMessageKeys(session: DoubleRatchetSession): void {
  if (session.skippedMessageKeys.size <= MAX_SKIPPED_MESSAGE_KEYS) {
    return;
  }
  const sortedIndexes = [...session.skippedMessageKeys.keys()].sort((left, right) => left - right);
  const toRemove = sortedIndexes.slice(0, session.skippedMessageKeys.size - MAX_SKIPPED_MESSAGE_KEYS);
  for (const index of toRemove) {
    session.skippedMessageKeys.delete(index);
  }
}

async function fillSkippedMessageKeysUntil(session: DoubleRatchetSession, targetMessageIndex: number): Promise<void> {
  while (session.receivingMessageIndex < targetMessageIndex) {
    const skippedIndex = session.receivingMessageIndex;
    const step = await deriveChainStep(session.receivingChainKey, skippedIndex);
    session.receivingChainKey = step.nextChainKey;
    session.skippedMessageKeys.set(skippedIndex, {
      messageKey: step.messageKey,
      iv: step.iv,
    });
    session.receivingMessageIndex += 1;
    trimSkippedMessageKeys(session);
  }
}

export async function encryptSessionMessage(
  session: DoubleRatchetSession,
  plainText: string,
  options?: {
    createdAt?: string;
  },
): Promise<SessionMessageEnvelopeV2> {
  assertOrThrow(typeof plainText === "string", "invalid_argument", "plainText must be a string.");

  if (session.requireRatchetKeyInNextMessage) {
    await ratchetSessionForLocalRotation(session);
  }

  const messageIndex = session.sendingMessageIndex;
  const chainStep = await deriveChainStep(session.sendingChainKey, messageIndex);
  session.sendingChainKey = chainStep.nextChainKey;
  session.sendingMessageIndex += 1;

  const ratchetPublicKey = await exportLocalRatchetPublicKey(session);
  const iv = chainStep.iv;
  const ivBase64 = bytesToBase64(iv);
  const createdAt = options?.createdAt ?? new Date().toISOString();

  const envelopeForAd = {
    version: E2EE_ENVELOPE_VERSION,
    envelopeType: "message" as const,
    algorithm: E2EE_PROTOCOL_ALGORITHM,
    conversationId: session.conversationId,
    senderUserId: session.localUserId,
    senderDeviceId: session.localDeviceId,
    recipientUserId: session.remoteUserId,
    recipientDeviceId: session.remoteDeviceId,
    sessionId: session.sessionId,
    messageIndex,
    previousChainLength: session.previousSendingChainLength,
    ratchetPublicKey,
    iv: ivBase64,
    createdAt,
  };
  const associatedData = buildSessionMessageAssociatedData(envelopeForAd);
  const associatedDataHash = await createAssociatedDataHash(associatedData);

  const messageKey = await importAesGcmKey(chainStep.messageKey, ["encrypt"]);
  const ciphertextBytes = await encryptAesGcm(
    messageKey,
    utf8ToBytes(plainText),
    iv,
    associatedData,
  );
  const ciphertext = bytesToBase64(ciphertextBytes);

  const envelopeWithoutSignature: Omit<SessionMessageEnvelopeV2, "signature"> = {
    ...envelopeForAd,
    associatedDataHash,
    ciphertext,
  };
  const signature = bytesToSignatureBase64(
    await signWithEcdsa(session.localIdentitySigningPrivateKey, buildSessionMessageSignaturePayload(envelopeWithoutSignature)),
  );

  session.updatedAt = createdAt;
  return {
    ...envelopeWithoutSignature,
    signature,
  };
}

export async function decryptSessionMessage(
  session: DoubleRatchetSession,
  envelope: SessionMessageEnvelopeV2,
): Promise<SessionDecryptResult> {
  assertSessionEnvelopeContext(session, envelope);
  const replayFingerprint = createReplayFingerprint(envelope);
  assertOrThrow(!session.replayFingerprints.has(replayFingerprint), "replay_detected", "Duplicate encrypted envelope rejected.");

  const envelopeWithoutSignature: Omit<SessionMessageEnvelopeV2, "signature"> = {
    version: envelope.version,
    envelopeType: envelope.envelopeType,
    algorithm: envelope.algorithm,
    conversationId: envelope.conversationId,
    senderUserId: envelope.senderUserId,
    senderDeviceId: envelope.senderDeviceId,
    recipientUserId: envelope.recipientUserId,
    recipientDeviceId: envelope.recipientDeviceId,
    sessionId: envelope.sessionId,
    messageIndex: envelope.messageIndex,
    previousChainLength: envelope.previousChainLength,
    ratchetPublicKey: envelope.ratchetPublicKey,
    iv: envelope.iv,
    ciphertext: envelope.ciphertext,
    associatedDataHash: envelope.associatedDataHash,
    createdAt: envelope.createdAt,
  };
  const signatureValid = await verifyWithEcdsa(
    session.remoteIdentitySigningPublicKey,
    signatureBase64ToBytes(envelope.signature),
    buildSessionMessageSignaturePayload(envelopeWithoutSignature),
  );
  assertOrThrow(signatureValid, "invalid_signature", "Encrypted envelope signature verification failed.");

  if (envelope.ratchetPublicKey !== session.remoteRatchetPublicKeyBase64) {
    await ratchetSessionForRemoteRotation(session, envelope.ratchetPublicKey);
  }

  const envelopeForAd = {
    version: envelope.version,
    envelopeType: envelope.envelopeType,
    algorithm: envelope.algorithm,
    conversationId: envelope.conversationId,
    senderUserId: envelope.senderUserId,
    senderDeviceId: envelope.senderDeviceId,
    recipientUserId: envelope.recipientUserId,
    recipientDeviceId: envelope.recipientDeviceId,
    sessionId: envelope.sessionId,
    messageIndex: envelope.messageIndex,
    previousChainLength: envelope.previousChainLength,
    ratchetPublicKey: envelope.ratchetPublicKey,
    iv: envelope.iv,
    createdAt: envelope.createdAt,
  };
  const associatedData = buildSessionMessageAssociatedData(envelopeForAd);
  const expectedAdHash = await createAssociatedDataHash(associatedData);
  assertOrThrow(
    bytesEqual(
      base64ToBytes(expectedAdHash, {
        label: "expected associatedDataHash",
      }),
      base64ToBytes(envelope.associatedDataHash, {
        label: "envelope associatedDataHash",
      }),
    ),
    "invalid_payload",
    "Envelope associated data hash mismatch.",
  );

  let messageKeyBytes: Uint8Array;
  let ivBytes: Uint8Array;

  if (envelope.messageIndex < session.receivingMessageIndex) {
    const skipped = session.skippedMessageKeys.get(envelope.messageIndex);
    assertOrThrow(!!skipped, "replay_detected", "Stale or replayed encrypted message index rejected.");
    session.skippedMessageKeys.delete(envelope.messageIndex);
    messageKeyBytes = skipped.messageKey;
    ivBytes = skipped.iv;
  } else {
    const gap = envelope.messageIndex - session.receivingMessageIndex;
    assertOrThrow(gap <= MAX_SKIPPED_MESSAGE_KEYS, "invalid_payload", "Message gap exceeds allowed skipped message threshold.", {
      gap,
      maxAllowed: MAX_SKIPPED_MESSAGE_KEYS,
    });
    await fillSkippedMessageKeysUntil(session, envelope.messageIndex);
    const chainStep = await deriveChainStep(session.receivingChainKey, envelope.messageIndex);
    messageKeyBytes = chainStep.messageKey;
    ivBytes = chainStep.iv;
    session.receivingChainKey = chainStep.nextChainKey;
    session.receivingMessageIndex = envelope.messageIndex + 1;
  }

  const ivFromEnvelope = base64ToBytes(envelope.iv, {
    label: "iv",
    expectedLength: 12,
  });
  assertOrThrow(bytesEqual(ivBytes, ivFromEnvelope), "invalid_payload", "Envelope IV does not match expected chain-derived IV.");
  const ciphertext = base64ToBytes(envelope.ciphertext, {
    label: "ciphertext",
  });

  const messageKey = await importAesGcmKey(messageKeyBytes, ["decrypt"]);
  const plaintextBytes = await decryptAesGcm(messageKey, ciphertext, ivBytes, associatedData);
  const plainText = bytesToUtf8(plaintextBytes);

  session.replayFingerprints.add(replayFingerprint);
  trimReplayFingerprints(session);
  session.updatedAt = new Date().toISOString();

  return {
    plainText,
    messageIndex: envelope.messageIndex,
  };
}

export function markReplayObserved(session: DoubleRatchetSession, envelope: SessionMessageEnvelopeV2): void {
  session.replayFingerprints.add(createReplayFingerprint(envelope));
  trimReplayFingerprints(session);
}

export function clearReplayState(session: DoubleRatchetSession): void {
  session.replayFingerprints.clear();
}
