import { useSyncExternalStore } from "react";
import { messlyCacheDb } from "../cache/messlyCacheDb";
import { supabase } from "../lib/supabaseClient";
import { setRealtimeCacheAccountScope, readCachedConversations, readCachedPresence, readCachedProfiles } from "../realtime/cache";
import { authService } from "../services/auth";
import { primeInitialChatCacheForStartup, setChatMessagesCacheAccountScope } from "../services/chat/chatApi";
import { spotifyListenAlongService } from "../services/connections/spotifyListenAlong";
import { friendsService } from "../services/friends";
import { gatewayService } from "../services/gateway";
import { notificationsService } from "../services/notifications";
import { markRuntimePerf, measureRuntimePerf } from "../services/observability/runtimePerformance";
import { presenceService } from "../services/presence";
import { presenceController } from "../services/presence/presenceController";
import { fetchProfileById } from "../services/profile/profileService";
import { spotifyPresenceService } from "../services/spotifyPresence";
import { conversationsActions } from "../stores/conversationsSlice";
import type { ConversationEntity, UserPresenceEntity, UserProfileEntity } from "../stores/entities";
import { presenceActions } from "../stores/presenceSlice";
import { profilesActions } from "../stores/profilesSlice";
import { messlyStore } from "../stores/store";

export type AppBootstrapPhase = "idle" | "running" | "ready" | "error";

export interface AppBootstrapSnapshot {
  phase: AppBootstrapPhase;
  userId: string | null;
  statusText: string;
  detailText: string;
  progress: number;
  error: string | null;
  updatedAt: number;
}

const DEFAULT_SNAPSHOT: AppBootstrapSnapshot = {
  phase: "idle",
  userId: null,
  statusText: "",
  detailText: "",
  progress: 0,
  error: null,
  updatedAt: Date.now(),
};
const BOOTSTRAP_SESSION_VALIDATION_TIMEOUT_MS = 12_000;
const BOOTSTRAP_OPTIONAL_TASK_TIMEOUT_MS = 12_000;
const BOOTSTRAP_CACHE_WARMUP_TIMEOUT_MS = 8_000;

function emitBootstrapDiagnostic(
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
    source: "renderer-bootstrap",
    event,
    level,
    details,
  }).catch(() => undefined);
}

function normalizeProgress(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function resolveErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = String(error.message ?? "").trim();
    if (message) {
      return message;
    }
  }
  return "Falha ao inicializar o Azyoons.";
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: number | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(message));
    }, Math.max(1_000, timeoutMs));
  });

  try {
    return await Promise.race([task, timeoutPromise]);
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  }
}

function stopRuntimeServices(): void {
  gatewayService.stop();
  presenceService.stop();
  presenceController.stop();
  spotifyPresenceService.stop();
  spotifyListenAlongService.stop();
  notificationsService.stop();
}

async function warmSupabaseRealtime(): Promise<void> {
  if (import.meta.env.PROD && (typeof window === "undefined" || !window.electronAPI)) {
    // Avoid eager websocket preconnect on public web; realtime channels connect on demand.
    return;
  }

  const accessToken = await authService.getValidatedEdgeAccessToken();
  if (accessToken) {
    try {
      await supabase.realtime.setAuth(accessToken);
    } catch {
      // Best effort.
    }
  }

  try {
    supabase.realtime.connect();
  } catch {
    // Best effort.
  }
}

let appShellWarmupPromise: Promise<unknown> | null = null;
let directMessagesSidebarWarmupPromise: Promise<unknown> | null = null;
let directMessageChatWarmupPromise: Promise<unknown> | null = null;

function warmAppShellChunk(): Promise<unknown> {
  if (!appShellWarmupPromise) {
    appShellWarmupPromise = import("../app/AppShell");
  }
  return appShellWarmupPromise;
}

function warmDirectMessagesSidebarChunk(): Promise<unknown> {
  if (!directMessagesSidebarWarmupPromise) {
    directMessagesSidebarWarmupPromise = import("../components/layout/DirectMessagesSidebar");
  }
  return directMessagesSidebarWarmupPromise;
}

function warmDirectMessageChatChunk(): Promise<unknown> {
  if (!directMessageChatWarmupPromise) {
    directMessageChatWarmupPromise = import("../components/chat/DirectMessageChatView");
  }
  return directMessageChatWarmupPromise;
}

interface RuntimeCacheSnapshot {
  profiles: Record<string, UserProfileEntity> | null;
  conversations: Record<string, ConversationEntity> | null;
  presence: Record<string, UserPresenceEntity> | null;
}

function hydrateStoreFromRuntimeCache(snapshot: RuntimeCacheSnapshot): void {
  const profiles = snapshot.profiles ? Object.values(snapshot.profiles) : [];
  const conversations = snapshot.conversations ? Object.values(snapshot.conversations) : [];
  const presence = snapshot.presence ? Object.values(snapshot.presence) : [];

  if (profiles.length > 0) {
    messlyStore.dispatch(profilesActions.profilesHydrated(profiles));
  }
  if (conversations.length > 0) {
    messlyStore.dispatch(conversationsActions.conversationsHydrated(conversations));
  }
  if (presence.length > 0) {
    messlyStore.dispatch(presenceActions.presenceHydrated(presence));
  }
}

async function warmLocalRuntimeCache(): Promise<RuntimeCacheSnapshot> {
  await messlyCacheDb.open().catch(() => undefined);
  const [profilesResult, conversationsResult, presenceResult] = await Promise.allSettled([
    readCachedProfiles(),
    readCachedConversations(),
    readCachedPresence(),
  ]);

  return {
    profiles: profilesResult.status === "fulfilled" ? profilesResult.value : null,
    conversations: conversationsResult.status === "fulfilled" ? conversationsResult.value : null,
    presence: presenceResult.status === "fulfilled" ? presenceResult.value : null,
  };
}

async function startPresenceStack(userId: string): Promise<void> {
  await presenceService.start(userId);
  presenceController.start(userId);
}

async function startGlobalListeners(userId: string): Promise<void> {
  notificationsService.start();
  await spotifyPresenceService.start(userId);
  spotifyListenAlongService.start(userId);
}

function scheduleDeferredTask(task: () => void, timeoutMs = 2_200): () => void {
  if (typeof window === "undefined") {
    task();
    return () => {};
  }

  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  let hasRun = false;

  const runOnce = (): void => {
    if (hasRun) {
      return;
    }
    hasRun = true;
    task();
  };

  const timeoutId = window.setTimeout(runOnce, Math.max(120, timeoutMs));
  const idleId =
    typeof idleWindow.requestIdleCallback === "function"
      ? idleWindow.requestIdleCallback(() => {
          window.clearTimeout(timeoutId);
          runOnce();
        }, { timeout: timeoutMs })
      : null;

  return () => {
    window.clearTimeout(timeoutId);
    if (idleId !== null && typeof idleWindow.cancelIdleCallback === "function") {
      idleWindow.cancelIdleCallback(idleId);
    }
  };
}

class AppBootstrapController {
  private snapshot: AppBootstrapSnapshot = { ...DEFAULT_SNAPSHOT };
  private listeners = new Set<() => void>();
  private runId = 0;
  private activeUserId: string | null = null;
  private runningPromise: Promise<void> | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): AppBootstrapSnapshot => this.snapshot;

  private isRunCurrent(runId: number): boolean {
    return runId === this.runId;
  }

  resetForGuest(): void {
    this.runId += 1;
    this.activeUserId = null;
    this.runningPromise = null;
    emitBootstrapDiagnostic("reset-for-guest", {
      runId: this.runId,
    }, "debug");
    setChatMessagesCacheAccountScope("guest");
    stopRuntimeServices();
    setRealtimeCacheAccountScope("guest");
    this.commit({
      phase: "idle",
      userId: null,
      statusText: "",
      detailText: "",
      progress: 0,
      error: null,
    });
  }

  async start(userIdRaw: string | null | undefined): Promise<void> {
    const userId = String(userIdRaw ?? "").trim();
    if (!userId) {
      this.resetForGuest();
      return;
    }

    if (this.snapshot.phase === "ready" && this.snapshot.userId === userId) {
      return;
    }

    if (this.runningPromise && this.activeUserId === userId) {
      return this.runningPromise;
    }

    const currentRunId = this.runId + 1;
    this.runId = currentRunId;
    this.activeUserId = userId;
    markRuntimePerf("bootstrap:start", {
      userId,
      runId: currentRunId,
    });
    emitBootstrapDiagnostic("start", {
      userId,
      runId: currentRunId,
    });

    this.commit({
      phase: "running",
      userId,
      statusText: "Inicializando Azyoons",
      detailText: "Inicializando Azyoons",
      progress: 0,
      error: null,
    });

    const execute = async (): Promise<void> => {
      setChatMessagesCacheAccountScope(userId);
      setRealtimeCacheAccountScope(userId);
      stopRuntimeServices();

      const updateRunning = (statusText: string, progress: number, detailText = statusText): boolean => {
        if (!this.isRunCurrent(currentRunId)) {
          return false;
        }
        emitBootstrapDiagnostic("phase-running", {
          userId,
          runId: currentRunId,
          statusText,
          detailText,
          progress,
        }, "debug");
        this.commit({
          phase: "running",
          userId,
          statusText,
          detailText,
          progress,
          error: null,
        });
        return true;
      };

      const runOptionalTask = async (taskId: string, task: () => Promise<void>): Promise<void> => {
        try {
          await withTimeout(
            task(),
            BOOTSTRAP_OPTIONAL_TASK_TIMEOUT_MS,
            `Bootstrap optional task timed out: ${taskId}`,
          );
        } catch (error) {
          emitBootstrapDiagnostic("optional-task-skipped", {
            userId,
            runId: currentRunId,
            taskId,
            reason: error instanceof Error ? error.message : String(error ?? "unknown"),
          }, "warn");
          if (import.meta.env.DEV) {
            console.warn(`[app-bootstrap] etapa ignorada: ${taskId}`, error);
          }
        }
      };

      if (!updateRunning("Inicializando Azyoons", 0.03, "Validando sessao")) {
        return;
      }

      let validatedToken: string | null = null;
      try {
        validatedToken = await withTimeout(
          authService.getValidatedEdgeAccessToken(),
          BOOTSTRAP_SESSION_VALIDATION_TIMEOUT_MS,
          "Tempo limite ao validar sessao.",
        );
      } catch (validationError) {
        emitBootstrapDiagnostic("session-validation-timeout", {
          userId,
          runId: currentRunId,
          reason: validationError instanceof Error ? validationError.message : String(validationError ?? "unknown"),
        }, "warn");
        if (import.meta.env.DEV) {
          console.warn("[app-bootstrap] validacao da sessao excedeu tempo limite", validationError);
        }
        validatedToken = await withTimeout(
          authService.getCurrentAccessToken().catch(() => null),
          Math.max(3_000, Math.trunc(BOOTSTRAP_SESSION_VALIDATION_TIMEOUT_MS / 2)),
          "Tempo limite ao recuperar token de acesso atual.",
        ).catch(() => null);
      }

      if (!validatedToken) {
        emitBootstrapDiagnostic("validated-token-missing", {
          userId,
          runId: currentRunId,
        }, "warn");
        if (import.meta.env.DEV) {
          console.warn("[app-bootstrap] token validado indisponivel; continuando com inicializacao degradada");
        }
      }

      if (!updateRunning("Carregando cache local", 0.16, "Restaurando dados locais")) {
        return;
      }
      let cacheSnapshot: RuntimeCacheSnapshot = {
        profiles: null,
        conversations: null,
        presence: null,
      };
      try {
        [cacheSnapshot] = await withTimeout(
          Promise.all([
            warmLocalRuntimeCache(),
            primeInitialChatCacheForStartup({
              accountId: userId,
              maxEntries: 12,
              maxAgeMs: 15 * 60_000,
            }),
          ]),
          BOOTSTRAP_CACHE_WARMUP_TIMEOUT_MS,
          "Tempo limite ao carregar cache local.",
        );
      } catch (cacheWarmupError) {
        emitBootstrapDiagnostic("cache-warmup-skipped", {
          userId,
          runId: currentRunId,
          reason: cacheWarmupError instanceof Error ? cacheWarmupError.message : String(cacheWarmupError ?? "unknown"),
        }, "warn");
        if (import.meta.env.DEV) {
          console.warn("[app-bootstrap] warmup de cache ignorado", cacheWarmupError);
        }
      }
      hydrateStoreFromRuntimeCache(cacheSnapshot);

      if (!updateRunning("Preparando interface", 0.72, "Aquecendo componentes em segundo plano")) {
        return;
      }
      void runOptionalTask("app-shell", async () => {
        await warmAppShellChunk();
      });
      void runOptionalTask("dm-sidebar", async () => {
        await warmDirectMessagesSidebarChunk();
      });
      void runOptionalTask("chat-view", async () => {
        await warmDirectMessageChatChunk();
      });

      if (!updateRunning("Finalizando inicializacao", 0.94, "Consolidando dados essenciais")) {
        return;
      }

      if (!this.isRunCurrent(currentRunId)) {
        return;
      }

      this.commit({
        phase: "ready",
        userId,
        statusText: "Azyoons pronto",
        detailText: "Azyoons pronto",
        progress: 1,
        error: null,
      });
      markRuntimePerf("bootstrap:ready", {
        userId,
        runId: currentRunId,
      });
      emitBootstrapDiagnostic("ready", {
        userId,
        runId: currentRunId,
      });
      measureRuntimePerf("bootstrap_total", "bootstrap:start", "bootstrap:ready", {
        userId,
        runId: currentRunId,
      });

      // Background boot: executa tarefas pesadas sem bloquear a primeira renderizacao do AppShell.
      const runDeferred = (taskId: string, task: () => Promise<void>, timeoutMs = 2_200): void => {
        if (!this.isRunCurrent(currentRunId)) {
          return;
        }

        const runSafely = (): void => {
          if (!this.isRunCurrent(currentRunId)) {
            return;
          }
          void runOptionalTask(taskId, task);
        };

        scheduleDeferredTask(runSafely, timeoutMs);
      };

      runDeferred("realtime", async () => {
        await warmSupabaseRealtime();
      }, 120);
      runDeferred("presence", async () => {
        await startPresenceStack(userId);
      }, 260);
      runDeferred("gateway", async () => {
        await gatewayService.start(userId);
      }, 520);
      runDeferred("messages", async () => {
        await friendsService.start(userId);
      });
      runDeferred("listeners", async () => {
        await startGlobalListeners(userId);
      }, 860);
      runDeferred("profile", async () => {
        await fetchProfileById(userId).catch(() => null);
      });
    };

    this.runningPromise = execute()
      .catch((error) => {
        if (currentRunId !== this.runId) {
          return;
        }
        emitBootstrapDiagnostic("error", {
          userId,
          runId: currentRunId,
          reason: resolveErrorMessage(error),
        }, "error");
        markRuntimePerf("bootstrap:error", {
          userId,
          runId: currentRunId,
          reason: resolveErrorMessage(error),
        });

        this.commit({
          phase: "error",
          userId,
          statusText: "Falha na inicializacao",
          detailText: resolveErrorMessage(error),
          progress: 1,
          error: resolveErrorMessage(error),
        });
      })
      .finally(() => {
        if (currentRunId === this.runId) {
          this.runningPromise = null;
        }
      });

    return this.runningPromise;
  }

  private commit(next: Partial<AppBootstrapSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...next,
      progress: normalizeProgress(next.progress ?? this.snapshot.progress),
      updatedAt: Date.now(),
    };

    this.listeners.forEach((listener) => listener());
  }
}

export const appBootstrap = new AppBootstrapController();

export function useAppBootstrapSnapshot(): AppBootstrapSnapshot {
  return useSyncExternalStore(appBootstrap.subscribe, appBootstrap.getSnapshot, appBootstrap.getSnapshot);
}
