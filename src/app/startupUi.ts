import { markRuntimePerf, measureRuntimePerf } from "../services/observability/runtimePerformance";

export const INITIAL_UI_READY_EVENT = "messly:initial-ui-ready";

export interface StartupUiReadyPayload {
  surface: "shell" | "auth";
  route: string;
  bootstrapPhase?: string | null;
}

let hasMarkedStartupUiReady = false;

export function dismissStartupLoader(): void {
  if (typeof document === "undefined") {
    return;
  }

  const loadingScreen = document.getElementById("messly-loading");
  if (!loadingScreen) {
    return;
  }

  if (loadingScreen.dataset.dismissed === "1") {
    return;
  }
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
  dismissStartupLoader();
  window.dispatchEvent(new CustomEvent<StartupUiReadyPayload>(INITIAL_UI_READY_EVENT, { detail: payload }));

  const signalRendererFirstFrameReady = window.electronAPI?.signalRendererFirstFrameReady;
  if (typeof signalRendererFirstFrameReady === "function") {
    signalRendererFirstFrameReady(payload);
  }
}
