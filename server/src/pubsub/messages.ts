import type { GatewayDispatchPayloadMap, GatewaySubscription } from "../protocol/dispatch";
import type { GatewayDispatchEvent } from "../protocol/opcodes";

export interface GatewayDispatchBusMessage<TEvent extends GatewayDispatchEvent = GatewayDispatchEvent> {
  kind: "dispatch";
  eventId: string;
  event: TEvent;
  occurredAt: string;
  targets: GatewaySubscription[];
  payload: GatewayDispatchPayloadMap[TEvent];
}

export interface GatewayControlBusMessage {
  kind: "control";
  control: "disconnect_session";
  sessionId: string;
  connectionId: string | null;
  targetInstanceId: string | null;
  reason: string;
  retryAfterMs: number;
}

export type GatewayBusMessage = GatewayDispatchBusMessage | GatewayControlBusMessage;
