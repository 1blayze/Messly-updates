import { supabase } from "../../lib/supabaseClient";
import type { PresenceGatewayEventPayload, PresenceGatewayEventType } from "./presenceTypes";

const PRESENCE_GATEWAY_CHANNEL = "messly:presence-gateway";
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 70_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const MAX_QUEUED_EVENTS = 20;

type PresenceGatewayConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

interface PresenceGatewaySignalPayload {
  user_id: string;
  timestamp: string;
}

export interface PresenceGatewayConnectionState {
  status: PresenceGatewayConnectionStatus;
  reconnectAttempt: number;
  lastError: string | null;
  lastConnectedAt: number | null;
  lastPongAt: number | null;
}

type PresenceGatewayEventListener = (payload: PresenceGatewayEventPayload) => void;
type PresenceGatewayStateListener = (state: PresenceGatewayConnectionState) => void;

const listeners = new Set<PresenceGatewayEventListener>();
const stateListeners = new Set<PresenceGatewayStateListener>();

let channel: ReturnType<typeof supabase.channel> | null = null;
let heartbeatTimerId: number | null = null;
let reconnectTimerId: number | null = null;
let currentUserId: string | null = null;
let queuedEvents: PresenceGatewayEventPayload[] = [];
let ensureConnectedPromise: Promise<void> | null = null;
let state: PresenceGatewayConnectionState = {
  status: "idle",
  reconnectAttempt: 0,
  lastError: null,
  lastConnectedAt: null,
  lastPongAt: null,
};

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function isGatewayEventType(value: unknown): value is PresenceGatewayEventType {
  return (
    value === "PRESENCE_UPDATE" ||
    value === "ACTIVITY_UPDATE" ||
    value === "SPOTIFY_UPDATE" ||
    value === "USER_ONLINE" ||
    value === "USER_OFFLINE"
  );
}

function notifyState(): void {
  stateListeners.forEach((listener) => listener({ ...state }));
}

function setState(patch: Partial<PresenceGatewayConnectionState>): void {
  state = {
    ...state,
    ...patch,
  };
  notifyState();
}

function clearHeartbeatTimer(): void {
  if (heartbeatTimerId !== null && isBrowser()) {
    window.clearInterval(heartbeatTimerId);
    heartbeatTimerId = null;
  }
}

function clearReconnectTimer(): void {
  if (reconnectTimerId !== null && isBrowser()) {
    window.clearTimeout(reconnectTimerId);
    reconnectTimerId = null;
  }
}

function normalizeSignalPayload(value: unknown): PresenceGatewaySignalPayload | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const casted = value as Record<string, unknown>;
  const userId = String(casted.user_id ?? "").trim();
  if (!userId) {
    return null;
  }

  const timestamp = String(casted.timestamp ?? "").trim() || new Date().toISOString();
  return {
    user_id: userId,
    timestamp,
  };
}

function normalizeGatewayPayload(
  event: PresenceGatewayEventType,
  value: unknown,
): PresenceGatewayEventPayload | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const casted = value as Record<string, unknown>;
  const userId = String(casted.user_id ?? "").trim();
  if (!userId) {
    return null;
  }

  const statusRaw = String(casted.status ?? "").trim().toLowerCase();
  const status =
    statusRaw === "online" || statusRaw === "idle" || statusRaw === "dnd" || statusRaw === "invisible"
      ? statusRaw
      : null;

  return {
    event,
    user_id: userId,
    status,
    activities: Array.isArray(casted.activities) ? casted.activities : [],
    timestamp: String(casted.timestamp ?? "").trim() || new Date().toISOString(),
  };
}

async function removeChannel(target: ReturnType<typeof supabase.channel> | null): Promise<void> {
  if (!target) {
    return;
  }
  try {
    await supabase.removeChannel(target);
  } catch {
    // Ignore channel disposal failures.
  }
}

function enqueueEvent(payload: PresenceGatewayEventPayload): void {
  const key = `${payload.event}:${payload.user_id}`;
  queuedEvents = queuedEvents.filter((entry) => `${entry.event}:${entry.user_id}` !== key);
  queuedEvents.push(payload);
  if (queuedEvents.length > MAX_QUEUED_EVENTS) {
    queuedEvents = queuedEvents.slice(queuedEvents.length - MAX_QUEUED_EVENTS);
  }
}

async function sendRawBroadcast(event: string, payload: unknown): Promise<void> {
  if (!channel || state.status !== "connected") {
    return;
  }

  await channel.send({
    type: "broadcast",
    event,
    payload,
  });
}

async function flushQueuedEvents(): Promise<void> {
  if (!channel || state.status !== "connected" || queuedEvents.length === 0) {
    return;
  }

  const pending = [...queuedEvents];
  queuedEvents = [];

  for (const payload of pending) {
    try {
      await sendRawBroadcast(payload.event, payload);
    } catch {
      enqueueEvent(payload);
      break;
    }
  }
}

async function respondToHeartbeatPing(payloadRaw: unknown): Promise<void> {
  const payload = normalizeSignalPayload(payloadRaw);
  if (!payload || !currentUserId || payload.user_id !== currentUserId) {
    return;
  }

  try {
    await sendRawBroadcast("GATEWAY_PONG", {
      user_id: currentUserId,
      timestamp: new Date().toISOString(),
    });
  } catch {
    // Ignore heartbeat response failures. The reconnect watchdog will recover.
  }
}

function handleHeartbeatPong(payloadRaw: unknown): void {
  const payload = normalizeSignalPayload(payloadRaw);
  if (!payload || !currentUserId || payload.user_id !== currentUserId) {
    return;
  }

  setState({
    lastPongAt: Date.now(),
  });
}

function emitGatewayEvent(event: PresenceGatewayEventType, payloadRaw: unknown): void {
  const payload = normalizeGatewayPayload(event, payloadRaw);
  if (!payload) {
    return;
  }

  listeners.forEach((listener) => listener(payload));
}

function startHeartbeat(): void {
  clearHeartbeatTimer();
  if (!isBrowser()) {
    return;
  }

  heartbeatTimerId = window.setInterval(() => {
    if (!currentUserId || state.status !== "connected") {
      return;
    }

    const nowMs = Date.now();
    const lastPongAt = state.lastPongAt ?? state.lastConnectedAt ?? 0;
    if (lastPongAt > 0 && nowMs - lastPongAt > HEARTBEAT_TIMEOUT_MS) {
      scheduleReconnect("heartbeat-timeout");
      return;
    }

    void sendRawBroadcast("GATEWAY_PING", {
      user_id: currentUserId,
      timestamp: new Date(nowMs).toISOString(),
    }).catch(() => {
      scheduleReconnect("heartbeat-send-failed");
    });
  }, HEARTBEAT_INTERVAL_MS);
}

function computeReconnectDelayMs(attempt: number): number {
  const safeAttempt = Math.max(0, Math.min(8, Math.floor(attempt)));
  const baseDelayMs = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * (2 ** safeAttempt));
  const jitterMs = Math.round(baseDelayMs * (0.2 + Math.random() * 0.3));
  return Math.min(RECONNECT_MAX_DELAY_MS, baseDelayMs + jitterMs);
}

function scheduleReconnect(reason: string): void {
  clearHeartbeatTimer();

  if (state.status === "connecting") {
    return;
  }

  const nextAttempt = state.reconnectAttempt + 1;
  const delayMs = computeReconnectDelayMs(nextAttempt);

  setState({
    status: "reconnecting",
    reconnectAttempt: nextAttempt,
    lastError: reason,
  });

  if (!isBrowser() || reconnectTimerId !== null) {
    return;
  }

  reconnectTimerId = window.setTimeout(() => {
    reconnectTimerId = null;
    void openChannel("reconnect");
  }, delayMs);
}

async function openChannel(reason: "initial" | "reconnect" = "initial"): Promise<void> {
  clearReconnectTimer();

  if (channel && (state.status === "connecting" || state.status === "connected")) {
    return;
  }

  const previousChannel = channel;
  channel = null;
  await removeChannel(previousChannel);

  const nextChannel = supabase.channel(PRESENCE_GATEWAY_CHANNEL, {
    config: {
      broadcast: {
        ack: false,
        self: true,
      },
    },
  });

  nextChannel
    .on("broadcast", { event: "PRESENCE_UPDATE" }, (payload) => {
      emitGatewayEvent("PRESENCE_UPDATE", payload.payload);
    })
    .on("broadcast", { event: "ACTIVITY_UPDATE" }, (payload) => {
      emitGatewayEvent("ACTIVITY_UPDATE", payload.payload);
    })
    .on("broadcast", { event: "SPOTIFY_UPDATE" }, (payload) => {
      emitGatewayEvent("SPOTIFY_UPDATE", payload.payload);
    })
    .on("broadcast", { event: "USER_ONLINE" }, (payload) => {
      emitGatewayEvent("USER_ONLINE", payload.payload);
    })
    .on("broadcast", { event: "USER_OFFLINE" }, (payload) => {
      emitGatewayEvent("USER_OFFLINE", payload.payload);
    })
    .on("broadcast", { event: "GATEWAY_PING" }, (payload) => {
      void respondToHeartbeatPing(payload.payload);
    })
    .on("broadcast", { event: "GATEWAY_PONG" }, (payload) => {
      handleHeartbeatPong(payload.payload);
    });

  channel = nextChannel;
  setState({
    status: reason === "initial" ? "connecting" : "reconnecting",
  });

  nextChannel.subscribe((status) => {
    if (channel !== nextChannel) {
      return;
    }

    if (status === "SUBSCRIBED") {
      setState({
        status: "connected",
        reconnectAttempt: 0,
        lastError: null,
        lastConnectedAt: Date.now(),
        lastPongAt: Date.now(),
      });
      startHeartbeat();
      void flushQueuedEvents();
      return;
    }

    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
      scheduleReconnect(status.toLowerCase());
    }
  });
}

export function setPresenceGatewayCurrentUser(userId: string | null | undefined): void {
  const normalizedUserId = String(userId ?? "").trim();
  currentUserId = normalizedUserId || null;
}

export async function ensurePresenceGatewayConnected(): Promise<void> {
  if (state.status === "connected" || state.status === "connecting") {
    return;
  }

  if (ensureConnectedPromise) {
    return ensureConnectedPromise;
  }

  const connectPromise = openChannel(state.reconnectAttempt > 0 ? "reconnect" : "initial");
  const trackedPromise = connectPromise.finally(() => {
    if (ensureConnectedPromise === trackedPromise) {
      ensureConnectedPromise = null;
    }
  });
  ensureConnectedPromise = trackedPromise;
  await trackedPromise;
}

export async function sendPresenceGatewayEvent(payload: PresenceGatewayEventPayload): Promise<void> {
  const normalized = normalizeGatewayPayload(payload.event, payload);
  if (!normalized || !isGatewayEventType(normalized.event)) {
    return;
  }

  if (!channel || state.status !== "connected") {
    enqueueEvent(normalized);
    await ensurePresenceGatewayConnected();
    return;
  }

  try {
    await sendRawBroadcast(normalized.event, normalized);
  } catch {
    enqueueEvent(normalized);
    scheduleReconnect("send-failed");
  }
}

export function subscribePresenceGatewayEvents(listener: PresenceGatewayEventListener): () => void {
  listeners.add(listener);
  void ensurePresenceGatewayConnected();
  return () => {
    listeners.delete(listener);
  };
}

export function subscribePresenceGatewayState(listener: PresenceGatewayStateListener): () => void {
  stateListeners.add(listener);
  listener({ ...state });
  void ensurePresenceGatewayConnected();
  return () => {
    stateListeners.delete(listener);
  };
}

export function disconnectPresenceGateway(): void {
  clearHeartbeatTimer();
  clearReconnectTimer();
  ensureConnectedPromise = null;
  const previousChannel = channel;
  channel = null;
  void removeChannel(previousChannel);
  setState({
    status: "disconnected",
    lastError: null,
  });
}
