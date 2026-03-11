import type { UnknownAction } from "@reduxjs/toolkit";
import type {
  GatewayDispatchEventType,
  GatewayDispatchPayloadMap,
  GatewayFrame,
} from "./protocol";
import { isGatewayDispatchEventType } from "./protocol";
import { gatewayActions } from "../stores/gatewaySlice";
import type { AppDispatch } from "../stores/store";
import { buildGatewayActions, type GatewayEventContext } from "../realtime/eventHandlers";
import { createMicrotaskBatcher } from "../utils/batch";

function isGatewayDispatchFrame(frame: GatewayFrame): frame is GatewayFrame<unknown> & {
  t: GatewayDispatchEventType;
} {
  return frame.op === "DISPATCH" && isGatewayDispatchEventType(frame.t);
}

export function createGatewayEventRouter(
  dispatch: AppDispatch,
  getContext: () => GatewayEventContext,
): {
  routeFrame: (frame: GatewayFrame) => void;
} {
  const pushAction = createMicrotaskBatcher<UnknownAction>((actions) => {
    actions.forEach((action) => dispatch(action));
  });

  return {
    routeFrame(frame: GatewayFrame): void {
      if (typeof frame.s === "number") {
        dispatch(
          gatewayActions.gatewaySessionUpdated({
            sessionId: null,
            seq: frame.s,
          }),
        );
      }

      if (!isGatewayDispatchFrame(frame)) {
        return;
      }

      const eventType = frame.t;
      const payload = frame.d as GatewayDispatchPayloadMap[typeof eventType];
      const actions = buildGatewayActions(eventType, payload, getContext());
      actions.forEach((action) => pushAction(action));
    },
  };
}
