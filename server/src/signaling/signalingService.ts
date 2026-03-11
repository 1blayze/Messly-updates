import type { EventBus } from "../events/eventBus";
import type { CallSignalPayload } from "../events/eventTypes";
import { WebRtcSignalingService } from "./webrtcSignaling";

export type { CallSignalPayload } from "../events/eventTypes";
export { WebRtcSignalingService as SignalingService };
export const createSignalingService = (eventBus: EventBus) => new WebRtcSignalingService(eventBus);
