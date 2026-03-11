import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Provider } from "react-redux";
import App from "./app/App";
import { attachStartupLoaderCleanup } from "./app/startupUi";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "./styles/base/material-symbols.css";
import { queryClient } from "./shared/queryClient";
import { messlyStore } from "./stores/store";
import { initializeRuntimeApiConfig } from "./config/runtimeApiConfig";
import { cleanupLegacyFirebaseArtifacts } from "./services/storage/legacyFirebaseCleanup";

const RootMode = import.meta.env.DEV ? React.Fragment : React.StrictMode;

async function bootstrap(): Promise<void> {
  await initializeRuntimeApiConfig();

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <RootMode>
      <Provider store={messlyStore}>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </Provider>
    </RootMode>
  );

  if (typeof window !== "undefined") {
    cleanupLegacyFirebaseArtifacts();
    attachStartupLoaderCleanup();
  }
}

void bootstrap();
