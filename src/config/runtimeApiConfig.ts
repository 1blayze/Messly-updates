function normalizeUrl(valueRaw: string | null | undefined): string | null {
  const value = String(valueRaw ?? "").trim();
  if (!value) {
    return null;
  }

  return value.replace(/\/+$/, "");
}

interface RuntimeApiConfigState {
  supabaseUrl: string | null;
  gatewayUrl: string | null;
  authApiUrl: string | null;
  appApiUrl: string | null;
  webOrigin: string | null;
  shellOrigin: string | null;
  mediaProxyUrl: string | null;
}

const runtimeApiConfigState: RuntimeApiConfigState = {
  supabaseUrl: null,
  gatewayUrl: null,
  authApiUrl: null,
  appApiUrl: null,
  webOrigin: null,
  shellOrigin: null,
  mediaProxyUrl: null,
};

let runtimeApiConfigReady = false;
let runtimeApiConfigPromise: Promise<void> | null = null;

function applySnapshot(snapshot: ElectronStartupSnapshot | null | undefined): void {
  const apiConfig = snapshot?.apiConfig;
  runtimeApiConfigState.supabaseUrl = normalizeUrl(apiConfig?.supabaseUrl);
  runtimeApiConfigState.gatewayUrl = normalizeUrl(apiConfig?.gatewayUrl);
  runtimeApiConfigState.authApiUrl = normalizeUrl(apiConfig?.authApiUrl);
  runtimeApiConfigState.appApiUrl = normalizeUrl(apiConfig?.appApiUrl);
  runtimeApiConfigState.webOrigin = normalizeUrl(apiConfig?.webOrigin);
  runtimeApiConfigState.shellOrigin = normalizeUrl(apiConfig?.shellOrigin);
  runtimeApiConfigState.mediaProxyUrl = normalizeUrl(apiConfig?.mediaProxyUrl);
}

export async function initializeRuntimeApiConfig(): Promise<void> {
  if (runtimeApiConfigReady) {
    return;
  }

  if (runtimeApiConfigPromise) {
    return runtimeApiConfigPromise;
  }

  runtimeApiConfigPromise = (async () => {
    if (typeof window === "undefined") {
      runtimeApiConfigReady = true;
      return;
    }

    const getStartupSnapshot = window.electronAPI?.getStartupSnapshot;
    if (typeof getStartupSnapshot !== "function") {
      runtimeApiConfigReady = true;
      return;
    }

    const snapshot = await getStartupSnapshot().catch(() => null);
    applySnapshot(snapshot);
    runtimeApiConfigReady = true;
  })();

  try {
    await runtimeApiConfigPromise;
  } finally {
    runtimeApiConfigPromise = null;
  }
}

export function getRuntimeApiSupabaseUrl(): string | null {
  return runtimeApiConfigState.supabaseUrl;
}

export function getRuntimeGatewayUrl(): string | null {
  return runtimeApiConfigState.gatewayUrl;
}

export function getRuntimeAuthApiUrl(): string | null {
  return runtimeApiConfigState.authApiUrl;
}

export function getRuntimeAppApiUrl(): string | null {
  return runtimeApiConfigState.appApiUrl;
}

export function getRuntimeWebOrigin(): string | null {
  return runtimeApiConfigState.webOrigin;
}

export function getRuntimeShellOrigin(): string | null {
  return runtimeApiConfigState.shellOrigin;
}

export function getRuntimeMediaProxyUrl(): string | null {
  return runtimeApiConfigState.mediaProxyUrl;
}
