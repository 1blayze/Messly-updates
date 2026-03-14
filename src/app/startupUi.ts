import { markRuntimePerf, measureRuntimePerf } from "../services/observability/runtimePerformance";

export const INITIAL_UI_READY_EVENT = "messly:initial-ui-ready";

export interface StartupUiReadyPayload {
  surface: "shell" | "auth";
  route: string;
  bootstrapPhase?: string | null;
}

let hasMarkedStartupUiReady = false;

function emitStartupUiDiagnostic(
  event: string,
  details: Record<string, unknown> = {},
  level: "debug" | "info" | "warn" | "error" = "info",
): void {
  if (typeof window === "undefined") {
    return;
  }

  const logDiagnostic = window.electronAPI?.logDiagnostic;
  if (typeof logDiagnostic !== "function") {
    return;
  }

  void logDiagnostic({
    source: "renderer-startup-ui",
    event,
    level,
    details,
  }).catch(() => undefined);
}

export function dismissStartupLoader(): void {
  if (typeof document === "undefined") {
    return;
  }

  const loadingScreen = document.getElementById("messly-loading");
  if (!loadingScreen) {
    emitStartupUiDiagnostic("loader-dismiss-skipped", {
      reason: "loader-not-found",
    }, "debug");
    return;
  }

  if (loadingScreen.dataset.dismissed === "1") {
    emitStartupUiDiagnostic("loader-dismiss-skipped", {
      reason: "already-dismissed",
    }, "debug");
    return;
  }
  emitStartupUiDiagnostic("loader-dismiss", {
    reason: "startup-ui-ready",
  });
  loadingScreen.dataset.dismissed = "1";
  loadingScreen.style.transition = "opacity 180ms ease, transform 220ms ease";
  loadingScreen.style.opacity = "0";
  loadingScreen.style.transform = "translateY(-4px)";
  window.setTimeout(() => {
    loadingScreen.remove();
  }, 220);
}

export function attachStartupLoaderCleanup(): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleInitialUiReady = (): void => {
    dismissStartupLoader();
    window.removeEventListener(INITIAL_UI_READY_EVENT, handleInitialUiReady);
  };

  window.addEventListener(INITIAL_UI_READY_EVENT, handleInitialUiReady);

  if (hasMarkedStartupUiReady) {
    dismissStartupLoader();
    window.removeEventListener(INITIAL_UI_READY_EVENT, handleInitialUiReady);
  }

  return () => {
    window.removeEventListener(INITIAL_UI_READY_EVENT, handleInitialUiReady);
  };
}

export function markStartupUiReady(payload: StartupUiReadyPayload): void {
  if (typeof window === "undefined" || hasMarkedStartupUiReady) {
    if (hasMarkedStartupUiReady) {
      emitStartupUiDiagnostic("mark-ready-skipped", {
        reason: "already-marked",
      }, "debug");
    }
    return;
  }

  markRuntimePerf("renderer:initial-ui-ready", {
    surface: payload.surface,
    route: payload.route,
    bootstrapPhase: payload.bootstrapPhase ?? null,
  });
  measureRuntimePerf(
    "renderer_root_render_to_initial_ui_ready",
    "renderer:root-render-dispatched",
    "renderer:initial-ui-ready",
    {
      surface: payload.surface,
      route: payload.route,
    },
  );

  hasMarkedStartupUiReady = true;
  emitStartupUiDiagnostic("mark-ready", {
    surface: payload.surface,
    route: payload.route,
    bootstrapPhase: payload.bootstrapPhase ?? null,
  });
  dismissStartupLoader();
  window.dispatchEvent(new CustomEvent<StartupUiReadyPayload>(INITIAL_UI_READY_EVENT, { detail: payload }));

  const signalRendererFirstFrameReady = window.electronAPI?.signalRendererFirstFrameReady;
  if (typeof signalRendererFirstFrameReady === "function") {
    emitStartupUiDiagnostic("signal-first-frame", {
      surface: payload.surface,
      route: payload.route,
    }, "debug");
    signalRendererFirstFrameReady(payload);
  } else {
    emitStartupUiDiagnostic("signal-first-frame-missing-api", {
      surface: payload.surface,
      route: payload.route,
    }, "warn");
  }
}
