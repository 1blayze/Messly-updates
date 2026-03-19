import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ForwardedRef,
} from "react";

const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const TURNSTILE_SCRIPT_ID = "messly-turnstile-script";
const TURNSTILE_LOAD_TIMEOUT_MS = 12_000;
const TURNSTILE_LOAD_MAX_ATTEMPTS = 2;
const TURNSTILE_RETRY_BASE_DELAY_MS = 1_500;
const TURNSTILE_RETRY_MAX_DELAY_MS = 15_000;
const TURNSTILE_ERROR_VISIBLE_AFTER_RETRIES = 3;
const TURNSTILE_COMPACT_BREAKPOINT_PX = 420;

interface TurnstileRenderOptions {
  sitekey: string;
  theme?: "auto" | "light" | "dark";
  language?: string;
  appearance?: "always" | "interaction-only" | "execute";
  size?: "normal" | "compact" | "flexible";
  callback?: (token: string) => void;
  "error-callback"?: () => void;
  "expired-callback"?: () => void;
  "timeout-callback"?: () => void;
}

interface TurnstileApi {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
}

export interface TurnstileDiagnosticEvent {
  code: string;
  message: string;
  attempt: number;
  timestamp: string;
  online: boolean;
  visibilityState: string;
  runtime: "desktop" | "web";
  rawError: string | null;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let turnstileScriptPromise: Promise<void> | null = null;

function resolveRetryDelayMs(retryCount: number): number {
  const normalizedRetryCount = Math.max(0, Math.trunc(retryCount));
  const exponentialFactor = Math.min(normalizedRetryCount, 4);
  return Math.min(TURNSTILE_RETRY_MAX_DELAY_MS, TURNSTILE_RETRY_BASE_DELAY_MS * 2 ** exponentialFactor);
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && String(error.message ?? "").trim()) {
    return String(error.message).trim();
  }
  return String(error ?? "unknown").trim() || "unknown";
}

function classifyTurnstileError(error: unknown): { code: string; message: string; rawError: string } {
  const rawError = normalizeErrorMessage(error);
  const normalized = rawError.toLowerCase();

  if (normalized.includes("timed out")) {
    return {
      code: "TURNSTILE_SCRIPT_TIMEOUT",
      message: "Tempo limite ao carregar a verificação de segurança.",
      rawError,
    };
  }
  if (normalized.includes("did not initialize")) {
    return {
      code: "TURNSTILE_API_NOT_INITIALIZED",
      message: "Script do Turnstile carregou, mas a API não inicializou.",
      rawError,
    };
  }
  if (normalized.includes("failed to load")) {
    return {
      code: "TURNSTILE_SCRIPT_LOAD_FAILED",
      message: "Falha ao carregar o script do Turnstile.",
      rawError,
    };
  }
  if (normalized.includes("render unavailable")) {
    return {
      code: "TURNSTILE_RENDER_UNAVAILABLE",
      message: "API do Turnstile indisponível para renderização.",
      rawError,
    };
  }

  return {
    code: "TURNSTILE_UNKNOWN_ERROR",
    message: "Falha inesperada ao iniciar a verificação de segurança.",
    rawError,
  };
}

function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && typeof window.electronAPI !== "undefined";
}

function removeTurnstileScriptElement(): void {
  const existing = document.getElementById(TURNSTILE_SCRIPT_ID);
  if (!existing) {
    return;
  }
  existing.remove();
}

function buildTurnstileScriptSrc(attemptIndex: number): string {
  if (attemptIndex <= 0) {
    return TURNSTILE_SCRIPT_SRC;
  }
  const separator = TURNSTILE_SCRIPT_SRC.includes("?") ? "&" : "?";
  return `${TURNSTILE_SCRIPT_SRC}${separator}retry=${Date.now()}-${attemptIndex}`;
}

function loadTurnstileScriptOnce(scriptSrc: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.id = TURNSTILE_SCRIPT_ID;
    script.src = scriptSrc;
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";

    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      script.removeEventListener("load", onLoad);
      script.removeEventListener("error", onError);
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const onLoad = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (window.turnstile?.render) {
        resolve();
        return;
      }
      reject(new Error("Turnstile API did not initialize."));
    };

    const onError = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      script.remove();
      reject(new Error("Failed to load Turnstile script."));
    };

    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });

    timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      script.remove();
      reject(new Error("Turnstile script loading timed out."));
    }, TURNSTILE_LOAD_TIMEOUT_MS);

    document.head.appendChild(script);
  });
}

function ensureTurnstileScriptLoaded(): Promise<void> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("Turnstile script unavailable in this environment."));
  }

  if (window.turnstile?.render) {
    return Promise.resolve();
  }

  if (turnstileScriptPromise) {
    return turnstileScriptPromise;
  }

  turnstileScriptPromise = (async () => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < TURNSTILE_LOAD_MAX_ATTEMPTS; attempt += 1) {
      removeTurnstileScriptElement();
      try {
        await loadTurnstileScriptOnce(buildTurnstileScriptSrc(attempt));
        return;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Failed to load Turnstile script.");
  })().finally(() => {
    turnstileScriptPromise = null;
  });

  return turnstileScriptPromise;
}

export interface TurnstileWidgetHandle {
  reset: () => void;
}

interface TurnstileWidgetProps {
  siteKey?: string | null;
  onVerify: (token: string) => void;
  onError?: () => void;
  onExpire?: () => void;
  onTimeout?: () => void;
  onDiagnostic?: (event: TurnstileDiagnosticEvent) => void;
  showErrors?: boolean;
  className?: string;
}

function TurnstileWidgetInner(
  { siteKey, onVerify, onError, onExpire, onTimeout, onDiagnostic, showErrors = true, className }: TurnstileWidgetProps,
  forwardedRef: ForwardedRef<TurnstileWidgetHandle>,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const renderInFlightRef = useRef(false);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbacksRef = useRef({
    onVerify,
    onError,
    onExpire,
    onTimeout,
    onDiagnostic,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isCompactSize, setIsCompactSize] = useState(false);

  callbacksRef.current = {
    onVerify,
    onError,
    onExpire,
    onTimeout,
    onDiagnostic,
  };

  useImperativeHandle(
    forwardedRef,
    () => ({
      reset: () => {
        const widgetId = widgetIdRef.current;
        if (!widgetId || !window.turnstile) {
          return;
        }
        window.turnstile.reset(widgetId);
      },
    }),
    [],
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const query = window.matchMedia(`(max-width: ${TURNSTILE_COMPACT_BREAKPOINT_PX}px)`);
    const syncSize = () => {
      setIsCompactSize(query.matches);
    };

    syncSize();

    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", syncSize);
      return () => {
        query.removeEventListener("change", syncSize);
      };
    }

    query.addListener(syncSize);
    return () => {
      query.removeListener(syncSize);
    };
  }, []);

  useEffect(() => {
    const normalizedSiteKey = String(siteKey ?? "").trim();
    const targetContainer = containerRef.current;

    if (!normalizedSiteKey || !targetContainer) {
      setIsLoading(false);
      setLoadError(null);
      retryCountRef.current = 0;
      renderInFlightRef.current = false;
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);
    retryCountRef.current = 0;

    const reportDiagnostic = (
      code: string,
      message: string,
      attempt: number,
      rawError: string | null = null,
      level: "info" | "warn" | "error" = "warn",
      extraDetails: Record<string, unknown> = {},
    ) => {
      const runtime = window.electronAPI ? "desktop" : "web";
      const payload: TurnstileDiagnosticEvent = {
        code,
        message,
        attempt,
        timestamp: new Date().toISOString(),
        online: Boolean(navigator.onLine),
        visibilityState: String(document.visibilityState ?? "unknown"),
        runtime,
        rawError,
      };

      callbacksRef.current.onDiagnostic?.(payload);

      if (import.meta.env.DEV) {
        const details = { ...payload, ...extraDetails };
        if (level === "error") {
          console.error("[turnstile:diagnostic]", details);
        } else if (level === "warn") {
          console.warn("[turnstile:diagnostic]", details);
        } else {
          console.info("[turnstile:diagnostic]", details);
        }
      }

      const logDiagnostic = window.electronAPI?.logDiagnostic;
      if (typeof logDiagnostic === "function") {
        void logDiagnostic({
          source: "turnstile",
          event: code,
          level,
          details: {
            ...payload,
            ...extraDetails,
          },
        }).catch(() => undefined);
      }
    };

    const renderWidget = () => {
      if (cancelled || renderInFlightRef.current) {
        return;
      }
      renderInFlightRef.current = true;
      void ensureTurnstileScriptLoaded()
        .then(() => {
          if (cancelled) {
            return;
          }

          const turnstileApi = window.turnstile;
          if (!turnstileApi?.render) {
            throw new Error("Turnstile render unavailable.");
          }

          const existingWidgetId = widgetIdRef.current;
          if (existingWidgetId) {
            try {
              turnstileApi.remove(existingWidgetId);
            } catch {
              // Ignore stale widget cleanup errors.
            }
            widgetIdRef.current = null;
          }

          targetContainer.innerHTML = "";
          const isDesktop = isDesktopRuntime();
          const widgetId = turnstileApi.render(targetContainer, {
            sitekey: normalizedSiteKey,
            theme: "dark",
            language: "pt-br",
            // Keep the verification card visible on register screen.
            appearance: "always",
            size: isCompactSize ? "compact" : "normal",
            callback: (token: string) => {
              if (cancelled) {
                return;
              }
              callbacksRef.current.onVerify(token);
            },
            "error-callback": () => {
              if (cancelled) {
                return;
              }
              reportDiagnostic(
                "TURNSTILE_WIDGET_ERROR_CALLBACK",
                "Turnstile retornou callback de erro.",
                retryCountRef.current + 1,
              );
              callbacksRef.current.onError?.();
            },
            "expired-callback": () => {
              if (cancelled) {
                return;
              }
              reportDiagnostic(
                "TURNSTILE_WIDGET_EXPIRED",
                "Token do Turnstile expirou.",
                retryCountRef.current + 1,
                null,
                "info",
              );
              callbacksRef.current.onExpire?.();
            },
            "timeout-callback": () => {
              if (cancelled) {
                return;
              }
              reportDiagnostic(
                "TURNSTILE_WIDGET_TIMEOUT",
                "Turnstile atingiu timeout de interação.",
                retryCountRef.current + 1,
              );
              callbacksRef.current.onTimeout?.();
            },
          });
          widgetIdRef.current = widgetId;
          retryCountRef.current = 0;
          setLoadError(null);
          setIsLoading(false);
        })
        .catch((error) => {
          if (cancelled) {
            return;
          }

          const classified = classifyTurnstileError(error);
          retryCountRef.current += 1;
          if (retryTimerRef.current !== null) {
            clearTimeout(retryTimerRef.current);
            retryTimerRef.current = null;
          }

          reportDiagnostic(
            classified.code,
            classified.message,
            retryCountRef.current,
            classified.rawError,
            "warn",
            {
              retryDelayMs: resolveRetryDelayMs(retryCountRef.current),
              siteKeyConfigured: Boolean(normalizedSiteKey),
            },
          );

          if (showErrors && retryCountRef.current >= TURNSTILE_ERROR_VISIBLE_AFTER_RETRIES) {
            setLoadError(`${classified.message} Tentando novamente...`);
          } else {
            setLoadError(null);
          }
          setIsLoading(true);
          retryTimerRef.current = setTimeout(() => {
            if (cancelled) {
              return;
            }
            renderWidget();
          }, resolveRetryDelayMs(retryCountRef.current));
        })
        .finally(() => {
          renderInFlightRef.current = false;
        });
    };

    const forceRetry = () => {
      if (cancelled || widgetIdRef.current) {
        return;
      }
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      setIsLoading(true);
      renderWidget();
    };

    const handleOnline = () => {
      forceRetry();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        forceRetry();
      }
    };

    const handleSecurityPolicyViolation = (event: Event) => {
      if (typeof SecurityPolicyViolationEvent === "undefined" || !(event instanceof SecurityPolicyViolationEvent)) {
        return;
      }
      const blockedUri = String(event.blockedURI ?? "").toLowerCase();
      const violatedDirective = String(event.violatedDirective ?? "");
      const effectiveDirective = String(event.effectiveDirective ?? "");

      if (!blockedUri.includes("challenges.cloudflare.com")) {
        return;
      }

      reportDiagnostic(
        "TURNSTILE_CSP_BLOCKED",
        "Turnstile bloqueado pela Content Security Policy.",
        retryCountRef.current + 1,
        null,
        "error",
        {
          blockedUri,
          violatedDirective,
          effectiveDirective,
        },
      );
    };

    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    document.addEventListener("securitypolicyviolation", handleSecurityPolicyViolation as EventListener);
    renderWidget();

    return () => {
      cancelled = true;
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      document.removeEventListener("securitypolicyviolation", handleSecurityPolicyViolation as EventListener);
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      renderInFlightRef.current = false;
      const currentWidgetId = widgetIdRef.current;
      if (!currentWidgetId || !window.turnstile) {
        return;
      }
      try {
        window.turnstile.remove(currentWidgetId);
      } catch {
        // Ignore stale widget cleanup errors.
      }
      widgetIdRef.current = null;
    };
  }, [siteKey, isCompactSize]);

  if (!String(siteKey ?? "").trim()) {
    return (
      <div className={className}>
        {showErrors ? (
          <p className="auth-feedback auth-feedback--error">
            Verificação de segurança indisponível. Tente novamente em instantes.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className={className}>
      {isLoading ? <p className="auth-note">Carregando verificação de segurança...</p> : null}
      {loadError && showErrors ? <p className="auth-feedback auth-feedback--error">{loadError}</p> : null}
      <div ref={containerRef} className="auth-turnstile-container" />
    </div>
  );
}

const TurnstileWidget = forwardRef(TurnstileWidgetInner);

export default TurnstileWidget;
