import { assertOrThrow, E2EEError } from "./errors";
import { createDeviceIdentity, toDevicePublicIdentity } from "./identity";
import { decryptSessionMessage, encryptSessionMessage } from "./message";
import { createDevicePreKeyBundle, createOneTimePreKeys, createSignedPreKey } from "./prekeys";
import {
  acceptSession,
  cloneSessionForRekey,
  destroySessionMaterial,
  initiateSession,
} from "./session";
import {
  assertSessionInitEnvelope,
  assertSessionMessageEnvelope,
} from "./serialization";
import { randomId } from "./runtime";
import type {
  AnyE2EEEnvelope,
  DeviceIdentityRecord,
  DevicePreKeyBundle,
  DevicePublicIdentity,
  DoubleRatchetSession,
  MembershipChangeReason,
  MembershipRekeyPlan,
  OneTimePreKeyRecord,
  SessionFanoutEnvelope,
  SessionInitEnvelope,
  SessionMessageEnvelopeV2,
  SignedPreKeyRecord,
} from "./types";

function makeDeviceKey(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`;
}

function makeConversationDeviceKey(conversationId: string, userId: string, deviceId: string): string {
  return `${conversationId}:${userId}:${deviceId}`;
}

export type SecureSessionStatus =
  | "secure_session_active"
  | "secure_session_pending"
  | "secure_session_missing"
  | "device_unverified"
  | "decrypt_failed";

export interface PendingOutboundMessage {
  id: string;
  conversationId: string;
  recipientUserId: string;
  recipientDeviceId: string;
  plainText: string;
  enqueuedAt: string;
  attempts: number;
  lastErrorCode?: string;
}

export interface FanoutTargetDevice {
  recipientUserId: string;
  recipientDeviceId: string;
  bundle?: DevicePreKeyBundle;
}

export interface FanoutEncryptionResult {
  envelopes: SessionFanoutEnvelope[];
  initEnvelopes: SessionInitEnvelope[];
  pendingMessages: PendingOutboundMessage[];
}

export interface ProtocolDecryptResult {
  plainText: string;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  messageIndex: number;
}

export interface ProtocolInitResult {
  sessionId: string;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  consumedOneTimePreKeyId?: string;
}

export interface E2EEProtocolControllerOptions {
  autoTrustFirstUse?: boolean;
  signedPreKeyTtlDays?: number;
  oneTimePreKeyCount?: number;
  extractablePersistableKeys?: boolean;
}

export class E2EEProtocolController {
  readonly localIdentity: DeviceIdentityRecord;
  readonly signedPreKey: SignedPreKeyRecord;
  readonly oneTimePreKeys: OneTimePreKeyRecord[];
  private readonly sessionsByConversationDevice = new Map<string, DoubleRatchetSession>();
  private readonly sessionsById = new Map<string, DoubleRatchetSession>();
  private readonly trustedDevices = new Map<string, DevicePublicIdentity>();
  private readonly unverifiedDevices = new Set<string>();
  private readonly revokedDevices = new Set<string>();
  private readonly pendingOutbound = new Map<string, PendingOutboundMessage[]>();
  private readonly blockedConversationDevices = new Map<string, Set<string>>();
  private readonly autoTrustFirstUse: boolean;

  private constructor(input: {
    localIdentity: DeviceIdentityRecord;
    signedPreKey: SignedPreKeyRecord;
    oneTimePreKeys: OneTimePreKeyRecord[];
    autoTrustFirstUse: boolean;
  }) {
    this.localIdentity = input.localIdentity;
    this.signedPreKey = input.signedPreKey;
    this.oneTimePreKeys = input.oneTimePreKeys;
    this.autoTrustFirstUse = input.autoTrustFirstUse;
  }

  static async create(input: {
    userId: string;
    deviceId?: string;
    options?: E2EEProtocolControllerOptions;
  }): Promise<E2EEProtocolController> {
    const options = input.options ?? {};
    const localIdentity = await createDeviceIdentity({
      userId: input.userId,
      deviceId: input.deviceId,
      extractable: options.extractablePersistableKeys === true,
    });
    const signedPreKey = await createSignedPreKey({
      userId: localIdentity.userId,
      deviceId: localIdentity.deviceId,
      identitySigningPrivateKey: localIdentity.identitySigningKeyPair.privateKey,
      ttlDays: options.signedPreKeyTtlDays,
      extractable: options.extractablePersistableKeys === true,
    });
    const oneTimePreKeys = await createOneTimePreKeys({
      count: options.oneTimePreKeyCount ?? 12,
      extractable: options.extractablePersistableKeys === true,
    });

    return new E2EEProtocolController({
      localIdentity,
      signedPreKey,
      oneTimePreKeys,
      autoTrustFirstUse: options.autoTrustFirstUse !== false,
    });
  }

  async getPublicBundle(): Promise<DevicePreKeyBundle> {
    const identity = await toDevicePublicIdentity(this.localIdentity);
    const nextOneTime = this.oneTimePreKeys.find((preKey) => !preKey.consumedAt) ?? null;
    return createDevicePreKeyBundle({
      identity,
      signedPreKey: this.signedPreKey,
      oneTimePreKey: nextOneTime,
    });
  }

  async getPublicIdentity(): Promise<DevicePublicIdentity> {
    return toDevicePublicIdentity(this.localIdentity);
  }

  trustDevice(identity: DevicePublicIdentity): void {
    const key = makeDeviceKey(identity.userId, identity.deviceId);
    this.trustedDevices.set(key, identity);
    this.unverifiedDevices.delete(key);
  }

  revokeDevice(userId: string, deviceId: string): void {
    const deviceKey = makeDeviceKey(userId, deviceId);
    this.revokedDevices.add(deviceKey);
    this.trustedDevices.delete(deviceKey);
    this.unverifiedDevices.delete(deviceKey);

    for (const [conversationKey, session] of this.sessionsByConversationDevice.entries()) {
      if (session.remoteUserId === userId && session.remoteDeviceId === deviceId) {
        destroySessionMaterial(session);
        this.sessionsByConversationDevice.delete(conversationKey);
        this.sessionsById.delete(session.sessionId);
      }
    }
  }

  getDeviceTrustState(userId: string, deviceId: string): "trusted" | "unverified" | "revoked" | "unknown" {
    const key = makeDeviceKey(userId, deviceId);
    if (this.revokedDevices.has(key)) {
      return "revoked";
    }
    if (this.trustedDevices.has(key)) {
      return "trusted";
    }
    if (this.unverifiedDevices.has(key)) {
      return "unverified";
    }
    return "unknown";
  }

  getSessionStatus(conversationId: string, remoteUserId: string, remoteDeviceId: string): SecureSessionStatus {
    const deviceKey = makeDeviceKey(remoteUserId, remoteDeviceId);
    const blockedForConversation = this.blockedConversationDevices.get(conversationId);
    if (blockedForConversation?.has(deviceKey)) {
      return "device_unverified";
    }
    if (this.revokedDevices.has(deviceKey)) {
      return "device_unverified";
    }
    const conversationKey = makeConversationDeviceKey(conversationId, remoteUserId, remoteDeviceId);
    if (this.sessionsByConversationDevice.has(conversationKey)) {
      return "secure_session_active";
    }
    const pending = this.pendingOutbound.get(conversationKey);
    if (pending && pending.length > 0) {
      return "secure_session_pending";
    }
    if (this.unverifiedDevices.has(deviceKey)) {
      return "device_unverified";
    }
    return "secure_session_missing";
  }

  getPendingOutboundMessages(conversationId: string, recipientUserId: string, recipientDeviceId: string): PendingOutboundMessage[] {
    const key = makeConversationDeviceKey(conversationId, recipientUserId, recipientDeviceId);
    return [...(this.pendingOutbound.get(key) ?? [])];
  }

  private getSession(conversationId: string, remoteUserId: string, remoteDeviceId: string): DoubleRatchetSession | null {
    const key = makeConversationDeviceKey(conversationId, remoteUserId, remoteDeviceId);
    return this.sessionsByConversationDevice.get(key) ?? null;
  }

  private setSession(session: DoubleRatchetSession): void {
    const key = makeConversationDeviceKey(session.conversationId, session.remoteUserId, session.remoteDeviceId);
    this.sessionsByConversationDevice.set(key, session);
    this.sessionsById.set(session.sessionId, session);
  }

  private queuePendingMessage(message: Omit<PendingOutboundMessage, "id" | "enqueuedAt" | "attempts">): PendingOutboundMessage {
    const pending: PendingOutboundMessage = {
      ...message,
      id: randomId("pending"),
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
    };
    const key = makeConversationDeviceKey(message.conversationId, message.recipientUserId, message.recipientDeviceId);
    const list = this.pendingOutbound.get(key) ?? [];
    list.push(pending);
    this.pendingOutbound.set(key, list);
    return pending;
  }

  private drainPendingMessagesFor(conversationId: string, recipientUserId: string, recipientDeviceId: string): PendingOutboundMessage[] {
    const key = makeConversationDeviceKey(conversationId, recipientUserId, recipientDeviceId);
    const queued = this.pendingOutbound.get(key) ?? [];
    this.pendingOutbound.delete(key);
    return queued;
  }

  async beginSessionWithBundle(conversationId: string, bundle: DevicePreKeyBundle): Promise<{
    session: DoubleRatchetSession;
    initEnvelope: SessionInitEnvelope;
  }> {
    const deviceKey = makeDeviceKey(bundle.identity.userId, bundle.identity.deviceId);
    assertOrThrow(!this.revokedDevices.has(deviceKey), "device_revoked", "Cannot create session with revoked device.");
    const expectedIdentity = this.trustedDevices.get(deviceKey);
    if (!expectedIdentity && !this.autoTrustFirstUse) {
      this.unverifiedDevices.add(deviceKey);
      throw new E2EEError("missing_key_material", "Remote device is not yet verified.");
    }

    const bootstrap = await initiateSession({
      conversationId,
      localIdentity: this.localIdentity,
      remoteBundle: bundle,
      expectedRemoteIdentity: expectedIdentity,
    });
    this.setSession(bootstrap.session);
    if (!expectedIdentity) {
      this.trustDevice(bundle.identity);
    }
    return bootstrap;
  }

  async handleSessionInitEnvelope(initEnvelopeRaw: SessionInitEnvelope | unknown): Promise<ProtocolInitResult> {
    const initEnvelope = assertSessionInitEnvelope(initEnvelopeRaw);
    const deviceKey = makeDeviceKey(initEnvelope.senderUserId, initEnvelope.senderDeviceId);
    assertOrThrow(!this.revokedDevices.has(deviceKey), "device_revoked", "Sender device is revoked.");

    const trustedIdentity = this.trustedDevices.get(deviceKey);
    if (!trustedIdentity && !this.autoTrustFirstUse) {
      this.unverifiedDevices.add(deviceKey);
      throw new E2EEError("missing_key_material", "Sender device is not verified.");
    }

    const accepted = await acceptSession({
      localIdentity: this.localIdentity,
      localSignedPreKey: this.signedPreKey,
      localOneTimePreKeys: this.oneTimePreKeys,
      initEnvelope,
      expectedRemoteIdentity: trustedIdentity,
    });
    this.setSession(accepted.session);
    if (!trustedIdentity) {
      this.trustDevice({
        userId: initEnvelope.senderUserId,
        deviceId: initEnvelope.senderDeviceId,
        identityDhPublicKey: initEnvelope.senderIdentityDhPublicKey,
        identitySigningPublicKey: initEnvelope.senderIdentitySigningPublicKey,
        keyAgreementAlgorithm: "ECDH-P256",
        signingAlgorithm: "ECDSA-P256-SHA256",
        createdAt: initEnvelope.createdAt,
      });
    }

    return {
      sessionId: accepted.session.sessionId,
      conversationId: accepted.session.conversationId,
      senderUserId: accepted.session.remoteUserId,
      senderDeviceId: accepted.session.remoteDeviceId,
      consumedOneTimePreKeyId: accepted.consumedOneTimePreKeyId,
    };
  }

  async encryptForDevice(input: {
    conversationId: string;
    recipientUserId: string;
    recipientDeviceId: string;
    plainText: string;
    bundle?: DevicePreKeyBundle;
  }): Promise<{
    envelope: SessionMessageEnvelopeV2 | null;
    initEnvelope?: SessionInitEnvelope;
    pending?: PendingOutboundMessage;
  }> {
    const deviceKey = makeDeviceKey(input.recipientUserId, input.recipientDeviceId);
    assertOrThrow(!this.revokedDevices.has(deviceKey), "device_revoked", "Recipient device is revoked.");
    const blockedForConversation = this.blockedConversationDevices.get(input.conversationId);
    assertOrThrow(!blockedForConversation?.has(deviceKey), "device_revoked", "Recipient device is no longer authorized for this conversation.");
    let session = this.getSession(input.conversationId, input.recipientUserId, input.recipientDeviceId);
    let initEnvelope: SessionInitEnvelope | undefined;

    if (!session && input.bundle) {
      const bootstrap = await this.beginSessionWithBundle(input.conversationId, input.bundle);
      session = bootstrap.session;
      initEnvelope = bootstrap.initEnvelope;
    }

    if (!session) {
      const pending = this.queuePendingMessage({
        conversationId: input.conversationId,
        recipientUserId: input.recipientUserId,
        recipientDeviceId: input.recipientDeviceId,
        plainText: input.plainText,
      });
      return {
        envelope: null,
        pending,
      };
    }

    const envelope = await encryptSessionMessage(session, input.plainText);
    return {
      envelope,
      initEnvelope,
    };
  }

  async encryptFanoutMessage(input: {
    conversationId: string;
    plainText: string;
    targets: FanoutTargetDevice[];
  }): Promise<FanoutEncryptionResult> {
    const envelopes: SessionFanoutEnvelope[] = [];
    const initEnvelopes: SessionInitEnvelope[] = [];
    const pendingMessages: PendingOutboundMessage[] = [];

    for (const target of input.targets) {
      const encrypted = await this.encryptForDevice({
        conversationId: input.conversationId,
        recipientUserId: target.recipientUserId,
        recipientDeviceId: target.recipientDeviceId,
        plainText: input.plainText,
        bundle: target.bundle,
      });
      if (encrypted.initEnvelope) {
        initEnvelopes.push(encrypted.initEnvelope);
      }
      if (encrypted.envelope) {
        envelopes.push({
          recipientUserId: target.recipientUserId,
          recipientDeviceId: target.recipientDeviceId,
          envelope: encrypted.envelope,
        });
      } else if (encrypted.pending) {
        pendingMessages.push(encrypted.pending);
      }
    }

    return {
      envelopes,
      initEnvelopes,
      pendingMessages,
    };
  }

  async retryPendingMessages(input: {
    conversationId: string;
    recipientUserId: string;
    recipientDeviceId: string;
  }): Promise<SessionMessageEnvelopeV2[]> {
    const pending = this.drainPendingMessagesFor(input.conversationId, input.recipientUserId, input.recipientDeviceId);
    if (pending.length === 0) {
      return [];
    }
    const session = this.getSession(input.conversationId, input.recipientUserId, input.recipientDeviceId);
    if (!session) {
      for (const item of pending) {
        item.attempts += 1;
        item.lastErrorCode = "missing_session";
      }
      this.pendingOutbound.set(makeConversationDeviceKey(input.conversationId, input.recipientUserId, input.recipientDeviceId), pending);
      return [];
    }
    const result: SessionMessageEnvelopeV2[] = [];
    for (const item of pending) {
      try {
        result.push(await encryptSessionMessage(session, item.plainText));
      } catch (error) {
        item.attempts += 1;
        item.lastErrorCode = error instanceof E2EEError ? error.code : "invalid_payload";
      }
    }
    return result;
  }

  async decryptEnvelope(envelopeRaw: AnyE2EEEnvelope | unknown): Promise<ProtocolDecryptResult | ProtocolInitResult> {
    if (typeof envelopeRaw !== "object" || envelopeRaw === null) {
      throw new E2EEError("invalid_payload", "Encrypted envelope must be an object.");
    }
    const envelopeType = (envelopeRaw as { envelopeType?: unknown }).envelopeType;
    if (envelopeType === "session_init") {
      return this.handleSessionInitEnvelope(envelopeRaw);
    }
    if (envelopeType !== "message") {
      throw new E2EEError("migration_unsupported", "Unsupported envelope type for E2EE protocol controller.");
    }

    const envelope = assertSessionMessageEnvelope(envelopeRaw);
    const senderDeviceKey = makeDeviceKey(envelope.senderUserId, envelope.senderDeviceId);
    const blockedForConversation = this.blockedConversationDevices.get(envelope.conversationId);
    assertOrThrow(!blockedForConversation?.has(senderDeviceKey), "device_revoked", "Sender device is no longer authorized for this conversation.");
    let session = this.sessionsById.get(envelope.sessionId) ?? null;
    if (!session) {
      session = this.getSession(envelope.conversationId, envelope.senderUserId, envelope.senderDeviceId);
    }
    if (!session) {
      throw new E2EEError("missing_session", "No active session for encrypted envelope.", {
        details: {
          conversationId: envelope.conversationId,
          senderUserId: envelope.senderUserId,
          senderDeviceId: envelope.senderDeviceId,
          sessionId: envelope.sessionId,
        },
      });
    }

    try {
      const decrypted = await decryptSessionMessage(session, envelope);
      return {
        plainText: decrypted.plainText,
        messageIndex: decrypted.messageIndex,
        conversationId: envelope.conversationId,
        senderUserId: envelope.senderUserId,
        senderDeviceId: envelope.senderDeviceId,
      };
    } catch (error) {
      if (error instanceof E2EEError) {
        throw error;
      }
      throw new E2EEError("decrypt_failed", "Encrypted envelope decryption failed.", {
        cause: error,
      });
    }
  }

  createMembershipRekeyPlan(conversationId: string, reason: MembershipChangeReason, rekeyDeviceIds: string[]): MembershipRekeyPlan {
    return {
      conversationId,
      reason,
      rekeyDeviceIds: [...new Set(rekeyDeviceIds)],
      generatedAt: new Date().toISOString(),
    };
  }

  applyMembershipRekeyPlan(plan: MembershipRekeyPlan): void {
    const targetIds = new Set(plan.rekeyDeviceIds);
    let blockedSet = this.blockedConversationDevices.get(plan.conversationId);
    if (!blockedSet) {
      blockedSet = new Set<string>();
      this.blockedConversationDevices.set(plan.conversationId, blockedSet);
    }

    if (plan.reason === "member_removed" || plan.reason === "device_revoked") {
      for (const deviceId of targetIds) {
        blockedSet.add(deviceId);
      }
    }
    if (plan.reason === "member_added" || plan.reason === "device_added") {
      for (const deviceId of targetIds) {
        blockedSet.delete(deviceId);
      }
      if (blockedSet.size === 0) {
        this.blockedConversationDevices.delete(plan.conversationId);
      }
    }

    for (const [key, session] of this.sessionsByConversationDevice.entries()) {
      if (session.conversationId !== plan.conversationId) {
        continue;
      }
      const remoteDeviceKey = makeDeviceKey(session.remoteUserId, session.remoteDeviceId);
      if (!targetIds.has(remoteDeviceKey)) {
        continue;
      }

      if (plan.reason === "member_removed" || plan.reason === "device_revoked") {
        destroySessionMaterial(session);
        this.sessionsByConversationDevice.delete(key);
        this.sessionsById.delete(session.sessionId);
      } else {
        const rotated = cloneSessionForRekey(session);
        this.sessionsByConversationDevice.set(key, rotated);
        this.sessionsById.delete(session.sessionId);
        this.sessionsById.set(rotated.sessionId, rotated);
      }
    }
  }
}
