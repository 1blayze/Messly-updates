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

interface TurnstileRenderOptions {
  sitekey: string;
  theme?: "auto" | "light" | "dark";
  appearance?: "always" | "interaction-only";
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
  showErrors?: boolean;
  className?: string;
}

function TurnstileWidgetInner(
  { siteKey, onVerify, onError, onExpire, onTimeout, showErrors = true, className }: TurnstileWidgetProps,
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
  });
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  callbacksRef.current = {
    onVerify,
    onError,
    onExpire,
    onTimeout,
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
          const widgetId = turnstileApi.render(targetContainer, {
            sitekey: normalizedSiteKey,
            theme: "dark",
            appearance: "always",
            size: "flexible",
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
              callbacksRef.current.onError?.();
            },
            "expired-callback": () => {
              if (cancelled) {
                return;
              }
              callbacksRef.current.onExpire?.();
            },
            "timeout-callback": () => {
              if (cancelled) {
                return;
              }
              callbacksRef.current.onTimeout?.();
            },
          });
          widgetIdRef.current = widgetId;
          retryCountRef.current = 0;
          setLoadError(null);
          setIsLoading(false);
        })
        .catch(() => {
          if (cancelled) {
            return;
          }

          retryCountRef.current += 1;
          if (retryTimerRef.current !== null) {
            clearTimeout(retryTimerRef.current);
            retryTimerRef.current = null;
          }

          if (showErrors && retryCountRef.current >= TURNSTILE_ERROR_VISIBLE_AFTER_RETRIES) {
            setLoadError("Nao foi possivel iniciar a verificacao. Tentando novamente...");
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

    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    renderWidget();

    return () => {
      cancelled = true;
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
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
  }, [siteKey]);

  if (!String(siteKey ?? "").trim()) {
    return (
      <div className={className}>
        {showErrors ? (
          <p className="auth-feedback auth-feedback--error">
            Verificacao de seguranca indisponivel. Tente novamente em instantes.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className={className}>
      {isLoading ? <p className="auth-note">Carregando verificacao de seguranca...</p> : null}
      {loadError && showErrors ? <p className="auth-feedback auth-feedback--error">{loadError}</p> : null}
      <div ref={containerRef} className="auth-turnstile-container" />
    </div>
  );
}

const TurnstileWidget = forwardRef(TurnstileWidgetInner);

export default TurnstileWidget;
