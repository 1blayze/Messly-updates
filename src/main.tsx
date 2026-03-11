import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Provider } from "react-redux";
import App from "./app/App";
import { attachStartupLoaderCleanup } from "./app/startupUi";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-ext-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-ext-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-ext-600.css";
import "./styles/base/material-symbols.css";
import { queryClient } from "./shared/queryClient";
import { messlyStore } from "./stores/store";
import { initializeRuntimeApiConfig } from "./config/runtimeApiConfig";
import { cleanupLegacyFirebaseArtifacts } from "./services/storage/legacyFirebaseCleanup";
import { markRuntimePerf, measureRuntimePerf } from "./services/observability/runtimePerformance";

const RootMode = import.meta.env.DEV ? React.Fragment : React.StrictMode;

function createDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, Math.max(0, Math.trunc(ms)));
  });
}

function scheduleBackgroundTask(task: () => void, timeoutMs = 1_200): void {
  if (typeof window === "undefined") {
    task();
    return;
  }

  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  };

  if (typeof idleWindow.requestIdleCallback === "function") {
    idleWindow.requestIdleCallback(task, {
      timeout: Math.max(120, timeoutMs),
    });
    return;
  }

  window.setTimeout(task, Math.max(120, timeoutMs));
}

async function bootstrap(): Promise<void> {
  markRuntimePerf("renderer:entry");
  const runtimeApiConfigPromise = initializeRuntimeApiConfig().catch(() => undefined);

  // Keep startup fast: do not block first paint for long-running async config I/O.
  await Promise.race([runtimeApiConfigPromise, createDelay(120)]);
  markRuntimePerf("renderer:startup-gate-released");

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <RootMode>
      <Provider store={messlyStore}>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </Provider>
    </RootMode>
  );
  markRuntimePerf("renderer:root-render-dispatched");
  measureRuntimePerf("renderer_entry_to_root_render", "renderer:entry", "renderer:root-render-dispatched");

  if (typeof window !== "undefined") {
    attachStartupLoaderCleanup();
    scheduleBackgroundTask(() => {
      cleanupLegacyFirebaseArtifacts();
      markRuntimePerf("renderer:legacy-storage-cleanup-finished");
    }, 1_800);
  }

  void runtimeApiConfigPromise.then(() => {
    markRuntimePerf("renderer:runtime-config-settled");
    measureRuntimePerf(
      "renderer_entry_to_runtime_config_settled",
      "renderer:entry",
      "renderer:runtime-config-settled",
    );
  });
}

void bootstrap();
