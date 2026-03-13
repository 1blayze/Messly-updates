import { z } from "zod";
import {
  gatewayDispatchEvents,
  gatewayOpcodes,
  gatewayPresenceStatuses,
  gatewayPublishEvents,
  gatewaySubscriptionTypes,
} from "./opcodes";
import type { GatewayDispatchEvent, GatewayPublishEvent } from "./opcodes";

const isoDateString = z.string().datetime().or(z.string().min(1));
const sequenceSchema = z.number().int().min(0);

export const gatewayOpcodeSchema = z.enum(gatewayOpcodes);
export const gatewayDispatchEventSchema = z.enum(gatewayDispatchEvents);
export const gatewayPublishEventSchema = z.enum(gatewayPublishEvents);
export const gatewayPresenceStatusSchema = z.enum(gatewayPresenceStatuses);
export const gatewaySubscriptionSchema = z
  .object({
    type: z.enum(gatewaySubscriptionTypes),
    id: z.string().trim().min(1).max(128),
  })
  .strict();

export const gatewayClientInfoSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    version: z.string().trim().min(1).max(32),
    platform: z.string().trim().min(1).max(32),
    clientType: z.enum(["desktop", "web", "mobile", "unknown"]).default("unknown"),
    deviceId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export const gatewayIdentifyPayloadSchema = z
  .object({
    token: z.string().trim().min(1).max(8_192),
    client: gatewayClientInfoSchema,
    subscriptions: z.array(gatewaySubscriptionSchema).max(1_000).default([]),
  })
  .strict();

export const gatewayResumePayloadSchema = z
  .object({
    token: z.string().trim().min(1).max(8_192),
    sessionId: z.string().trim().uuid(),
    resumeToken: z.string().trim().min(1).max(256),
    seq: sequenceSchema,
    subscriptions: z.array(gatewaySubscriptionSchema).max(1_000).optional(),
  })
  .strict();

export const gatewayHeartbeatPayloadSchema = z
  .object({
    lastSequence: sequenceSchema.nullable().optional(),
    nonce: z.string().trim().max(64).optional(),
    sentAt: isoDateString.optional(),
  })
  .strict();

export const gatewaySubscriptionUpdateSchema = z
  .object({
    subscriptions: z.array(gatewaySubscriptionSchema).max(1_000),
  })
  .strict();

export const gatewayPresencePublishPayloadSchema = z
  .object({
    presence: z
      .object({
        status: gatewayPresenceStatusSchema,
        activities: z.array(z.record(z.string(), z.unknown())).max(32).default([]),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();

export const gatewayTypingPublishPayloadSchema = z
  .object({
    conversationId: z.string().trim().uuid(),
  })
  .strict();

export const gatewaySpotifyPublishPayloadSchema = z
  .object({
    userId: z.string().trim().uuid().optional(),
    status: gatewayPresenceStatusSchema,
    activity: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();

const baseFrameSchema = z
  .object({
    op: gatewayOpcodeSchema,
    s: sequenceSchema.nullable().optional().default(null),
    t: z.string().nullable().optional().default(null),
    d: z.unknown(),
  })
  .strict();

const identifyFrameSchema = baseFrameSchema.extend({
  op: z.literal("IDENTIFY"),
  d: gatewayIdentifyPayloadSchema,
});

const resumeFrameSchema = baseFrameSchema.extend({
  op: z.literal("RESUME"),
  d: gatewayResumePayloadSchema,
});

const heartbeatFrameSchema = baseFrameSchema.extend({
  op: z.literal("HEARTBEAT"),
  d: gatewayHeartbeatPayloadSchema,
});

const pingFrameSchema = baseFrameSchema.extend({
  op: z.literal("PING"),
  d: z.record(z.string(), z.unknown()).optional().default({}),
});

const pongFrameSchema = baseFrameSchema.extend({
  op: z.literal("PONG"),
  d: z.record(z.string(), z.unknown()).optional().default({}),
});

const subscribeFrameSchema = baseFrameSchema.extend({
  op: z.literal("SUBSCRIBE"),
  d: gatewaySubscriptionUpdateSchema,
});

const unsubscribeFrameSchema = baseFrameSchema.extend({
  op: z.literal("UNSUBSCRIBE"),
  d: gatewaySubscriptionUpdateSchema,
});

const publishFrameSchema = baseFrameSchema.superRefine((value, ctx) => {
  if (value.op !== "PUBLISH") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected PUBLISH opcode.",
    });
    return;
  }

  const publishEvent = gatewayPublishEventSchema.safeParse(value.t);
  if (!publishEvent.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Invalid publish event type.",
      path: ["t"],
    });
    return;
  }

  const schema = resolvePublishSchema(publishEvent.data);
  const parsedPayload = schema.safeParse(value.d);
  if (!parsedPayload.success) {
    parsedPayload.error.issues.forEach((issue) => {
      ctx.addIssue({
        ...issue,
        path: ["d", ...issue.path],
      });
    });
  }
});

export type ParsedInboundFrame =
  | z.infer<typeof identifyFrameSchema>
  | z.infer<typeof resumeFrameSchema>
  | z.infer<typeof heartbeatFrameSchema>
  | z.infer<typeof pingFrameSchema>
  | z.infer<typeof pongFrameSchema>
  | z.infer<typeof subscribeFrameSchema>
  | z.infer<typeof unsubscribeFrameSchema>
  | z.infer<typeof publishFrameSchema>;

export function resolvePublishSchema(eventType: GatewayPublishEvent) {
  switch (eventType) {
    case "PRESENCE_UPDATE":
      return gatewayPresencePublishPayloadSchema;
    case "TYPING_START":
    case "TYPING_STOP":
      return gatewayTypingPublishPayloadSchema;
    case "SPOTIFY_UPDATE":
      return gatewaySpotifyPublishPayloadSchema;
  }
}

export function parseInboundFrame(raw: string): ParsedInboundFrame {
  const parsedJson = JSON.parse(raw) as unknown;
  const baseFrame = baseFrameSchema.parse(parsedJson);
  switch (baseFrame.op) {
    case "IDENTIFY":
      return identifyFrameSchema.parse(baseFrame);
    case "RESUME":
      return resumeFrameSchema.parse(baseFrame);
    case "HEARTBEAT":
      return heartbeatFrameSchema.parse(baseFrame);
    case "PING":
      return pingFrameSchema.parse(baseFrame);
    case "PONG":
      return pongFrameSchema.parse(baseFrame);
    case "SUBSCRIBE":
      return subscribeFrameSchema.parse(baseFrame);
    case "UNSUBSCRIBE":
      return unsubscribeFrameSchema.parse(baseFrame);
    case "PUBLISH":
      return publishFrameSchema.parse(baseFrame);
    default:
      throw new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          message: `Opcode ${baseFrame.op} is not accepted from clients.`,
          path: ["op"],
        },
      ]);
  }
}

export function isGatewayDispatchEvent(value: unknown): value is GatewayDispatchEvent {
  return gatewayDispatchEventSchema.safeParse(value).success;
}
