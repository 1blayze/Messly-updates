import { strict as assert } from "node:assert";
import { test } from "node:test";

import { bytesToSignatureBase64, signWithEcdsa } from "../algorithms";
import { base64ToBytes, bytesToBase64 } from "../encoding";
import { E2EEError } from "../errors";
import { createDeviceIdentity, toDevicePublicIdentity } from "../identity";
import { decryptSessionMessage, encryptSessionMessage } from "../message";
import { createDevicePreKeyBundle, createOneTimePreKeys, createSignedPreKey } from "../prekeys";
import { E2EEProtocolController } from "../protocol";
import {
  assertSessionMessageEnvelope,
  buildSessionMessageSignaturePayload,
  deserializeEnvelope,
  serializeEnvelope,
} from "../serialization";
import {
  acceptSession,
  initiateSession,
} from "../session";
import {
  deserializeDeviceIdentity,
  getOrCreateWrappingKey,
  InMemoryKeyValueStore,
  serializeDeviceIdentity,
} from "../storage";
import { E2EE_ENVELOPE_VERSION, E2EE_PROTOCOL_ALGORITHM } from "../types";

async function bootstrapLowLevelSessions(conversationId: string) {
  const aliceIdentity = await createDeviceIdentity({
    userId: "alice",
    deviceId: "alice-device-1",
  });
  const bobIdentity = await createDeviceIdentity({
    userId: "bob",
    deviceId: "bob-device-1",
  });

  const bobSignedPreKey = await createSignedPreKey({
    userId: bobIdentity.userId,
    deviceId: bobIdentity.deviceId,
    identitySigningPrivateKey: bobIdentity.identitySigningKeyPair.privateKey,
  });
  const bobOneTimePreKeys = await createOneTimePreKeys({
    count: 2,
  });

  const bobBundle = await createDevicePreKeyBundle({
    identity: await toDevicePublicIdentity(bobIdentity),
    signedPreKey: bobSignedPreKey,
    oneTimePreKey: bobOneTimePreKeys[0],
  });

  const initiated = await initiateSession({
    conversationId,
    localIdentity: aliceIdentity,
    remoteBundle: bobBundle,
  });

  const accepted = await acceptSession({
    localIdentity: bobIdentity,
    localSignedPreKey: bobSignedPreKey,
    localOneTimePreKeys: bobOneTimePreKeys,
    initEnvelope: initiated.initEnvelope,
  });

  return {
    aliceIdentity,
    bobIdentity,
    aliceSession: initiated.session,
    bobSession: accepted.session,
  };
}

test("encrypt/decrypt happy path between two devices", async () => {
  const { aliceSession, bobSession } = await bootstrapLowLevelSessions("conv-happy");
  const encrypted = await encryptSessionMessage(aliceSession, "hello secure world");
  const decrypted = await decryptSessionMessage(bobSession, encrypted);
  assert.equal(decrypted.plainText, "hello secure world");
  assert.equal(decrypted.messageIndex, 0);
});

test("decrypt fails when IV is tampered even with valid signature", async () => {
  const { aliceSession, bobSession, aliceIdentity } = await bootstrapLowLevelSessions("conv-invalid-iv");
  const envelope = await encryptSessionMessage(aliceSession, "message with iv check");
  const ivBytes = base64ToBytes(envelope.iv, {
    label: "iv",
    expectedLength: 12,
  });
  ivBytes[0] ^= 0xff;

  const tamperedWithoutSignature = {
    ...envelope,
    iv: bytesToBase64(ivBytes),
  };
  const signature = await signWithEcdsa(
    aliceIdentity.identitySigningKeyPair.privateKey,
    buildSessionMessageSignaturePayload(tamperedWithoutSignature),
  );
  const tamperedEnvelope = {
    ...tamperedWithoutSignature,
    signature: bytesToSignatureBase64(signature),
  };

  await assert.rejects(
    () => decryptSessionMessage(bobSession, tamperedEnvelope),
    (error: unknown) => error instanceof E2EEError && error.code === "invalid_payload",
  );
});

test("decrypt fails when ciphertext is tampered", async () => {
  const { aliceSession, bobSession, aliceIdentity } = await bootstrapLowLevelSessions("conv-tampered-ciphertext");
  const envelope = await encryptSessionMessage(aliceSession, "message with auth tag");
  const ciphertext = base64ToBytes(envelope.ciphertext, {
    label: "ciphertext",
  });
  ciphertext[ciphertext.length - 1] ^= 0x01;
  const tamperedWithoutSignature = {
    ...envelope,
    ciphertext: bytesToBase64(ciphertext),
  };
  const signature = await signWithEcdsa(
    aliceIdentity.identitySigningKeyPair.privateKey,
    buildSessionMessageSignaturePayload(tamperedWithoutSignature),
  );
  const tamperedEnvelope = {
    ...tamperedWithoutSignature,
    signature: bytesToSignatureBase64(signature),
  };

  await assert.rejects(
    () => decryptSessionMessage(bobSession, tamperedEnvelope),
    (error: unknown) => error instanceof E2EEError && error.code === "decrypt_failed",
  );
});

test("wrap/unwrap identity key material with protected local storage", async () => {
  const identity = await createDeviceIdentity({
    userId: "storage-user",
    deviceId: "storage-device",
    extractable: true,
  });
  const store = new InMemoryKeyValueStore();
  const wrappingKey = await getOrCreateWrappingKey(store);

  const persisted = await serializeDeviceIdentity(identity, wrappingKey);
  const restored = await deserializeDeviceIdentity(persisted, wrappingKey);
  const restoredPublic = await toDevicePublicIdentity(restored);

  assert.equal(restoredPublic.userId, identity.userId);
  assert.equal(restoredPublic.deviceId, identity.deviceId);
  assert.ok(restoredPublic.identityDhPublicKey.length > 0);
  assert.ok(restoredPublic.identitySigningPublicKey.length > 0);
});

test("session bootstrap and bidirectional messages between two devices", async () => {
  const { aliceSession, bobSession } = await bootstrapLowLevelSessions("conv-two-way");

  const first = await encryptSessionMessage(aliceSession, "from alice");
  const firstResult = await decryptSessionMessage(bobSession, first);
  assert.equal(firstResult.plainText, "from alice");

  const response = await encryptSessionMessage(bobSession, "from bob");
  const responseResult = await decryptSessionMessage(aliceSession, response);
  assert.equal(responseResult.plainText, "from bob");
});

test("double ratchet rotation updates remote ratchet key", async () => {
  const { aliceSession, bobSession } = await bootstrapLowLevelSessions("conv-ratchet");

  const initialRemoteRatchet = aliceSession.remoteRatchetPublicKeyBase64;
  const firstInbound = await encryptSessionMessage(bobSession, "ratchet message");
  await decryptSessionMessage(aliceSession, firstInbound);

  assert.notEqual(aliceSession.remoteRatchetPublicKeyBase64, initialRemoteRatchet);
  assert.equal(bobSession.sendingMessageIndex, 1);
});

test("replay detection rejects duplicated envelopes", async () => {
  const { aliceSession, bobSession } = await bootstrapLowLevelSessions("conv-replay");

  const envelope = await encryptSessionMessage(aliceSession, "single delivery");
  await decryptSessionMessage(bobSession, envelope);
  await assert.rejects(
    () => decryptSessionMessage(bobSession, envelope),
    (error: unknown) => error instanceof E2EEError && error.code === "replay_detected",
  );
});

test("multi-device fanout delivers to all authorized recipient devices", async () => {
  const alice = await E2EEProtocolController.create({
    userId: "alice",
    deviceId: "alice-main",
  });
  const bobDeviceA = await E2EEProtocolController.create({
    userId: "bob",
    deviceId: "bob-a",
  });
  const bobDeviceB = await E2EEProtocolController.create({
    userId: "bob",
    deviceId: "bob-b",
  });

  const conversationId = "conv-multi";
  const fanout = await alice.encryptFanoutMessage({
    conversationId,
    plainText: "fanout payload",
    targets: [
      {
        recipientUserId: "bob",
        recipientDeviceId: "bob-a",
        bundle: await bobDeviceA.getPublicBundle(),
      },
      {
        recipientUserId: "bob",
        recipientDeviceId: "bob-b",
        bundle: await bobDeviceB.getPublicBundle(),
      },
    ],
  });

  assert.equal(fanout.pendingMessages.length, 0);
  assert.equal(fanout.initEnvelopes.length, 2);
  assert.equal(fanout.envelopes.length, 2);

  for (const initEnvelope of fanout.initEnvelopes) {
    if (initEnvelope.recipientDeviceId === "bob-a") {
      await bobDeviceA.handleSessionInitEnvelope(initEnvelope);
    } else {
      await bobDeviceB.handleSessionInitEnvelope(initEnvelope);
    }
  }

  for (const item of fanout.envelopes) {
    if (item.recipientDeviceId === "bob-a") {
      const decrypted = await bobDeviceA.decryptEnvelope(item.envelope);
      assert.equal((decrypted as { plainText: string }).plainText, "fanout payload");
    } else {
      const decrypted = await bobDeviceB.decryptEnvelope(item.envelope);
      assert.equal((decrypted as { plainText: string }).plainText, "fanout payload");
    }
  }
});

test("removed member/device cannot receive new conversation payloads", async () => {
  const alice = await E2EEProtocolController.create({
    userId: "alice",
    deviceId: "alice-main",
  });
  const bob = await E2EEProtocolController.create({
    userId: "bob",
    deviceId: "bob-main",
  });

  const conversationId = "conv-member-removal";
  const first = await alice.encryptForDevice({
    conversationId,
    recipientUserId: "bob",
    recipientDeviceId: "bob-main",
    plainText: "before removal",
    bundle: await bob.getPublicBundle(),
  });
  assert.ok(first.initEnvelope);
  assert.ok(first.envelope);
  await bob.handleSessionInitEnvelope(first.initEnvelope!);
  await bob.decryptEnvelope(first.envelope!);

  const plan = alice.createMembershipRekeyPlan(conversationId, "member_removed", ["bob:bob-main"]);
  alice.applyMembershipRekeyPlan(plan);

  await assert.rejects(
    () =>
      alice.encryptForDevice({
        conversationId,
        recipientUserId: "bob",
        recipientDeviceId: "bob-main",
        plainText: "after removal",
      }),
    (error: unknown) => error instanceof E2EEError && error.code === "device_revoked",
  );
});

test("envelope migration supports legacy and versioned v2 payloads", async () => {
  const legacyEnvelope = {
    version: 1 as const,
    envelopeType: "legacy_message" as const,
    ivBase64: bytesToBase64(new Uint8Array(12)),
    cipherTextBase64: bytesToBase64(new Uint8Array([1, 2, 3, 4])),
  };
  const parsedLegacy = deserializeEnvelope(serializeEnvelope(legacyEnvelope));
  assert.equal(parsedLegacy.envelopeType, "legacy_message");

  const { aliceSession } = await bootstrapLowLevelSessions("conv-v2-envelope");
  const v2Envelope = await encryptSessionMessage(aliceSession, "v2 payload");
  const parsedV2 = deserializeEnvelope(serializeEnvelope(v2Envelope));
  const validatedV2 = assertSessionMessageEnvelope(parsedV2);
  assert.equal(validatedV2.envelopeType, "message");
  assert.equal(validatedV2.version, E2EE_ENVELOPE_VERSION);
  assert.equal(validatedV2.algorithm, E2EE_PROTOCOL_ALGORITHM);
  assert.equal(validatedV2.messageIndex, 0);
});
