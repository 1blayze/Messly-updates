import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MaterialSymbolIcon from "../ui/MaterialSymbolIcon";
import Tooltip from "../ui/Tooltip";
import chatIconSrc from "../../assets/icons/ui/Chat.svg";
import "../../styles/components/TopBar.css";

interface TopBarProps {
  section?: "friends" | "directMessages";
  onPrepareForUpdateInstall?: () => Promise<void> | void;
}

const UPDATER_BACKGROUND_CHECK_MIN_INTERVAL_MS = 45_000;

function getSectionIconName(section: TopBarProps["section"]): string {
  switch (section) {
    case "directMessages":
      return "chat";
    case "friends":
    default:
      return "group";
  }
}

function getSectionLabel(section: TopBarProps["section"]): string {
  switch (section) {
    case "directMessages":
      return "Mensagens diretas";
    case "friends":
    default:
      return "Amigos";
  }
}

function normalizeUpdaterStatus(state: AppUpdaterState | null | undefined): AppUpdaterStatus {
  const status = String(state?.status ?? "").trim().toLowerCase();
  if (!status) {
    return "idle";
  }
  return status as AppUpdaterStatus;
}

function isUpdateActionVisible(status: AppUpdaterStatus): boolean {
  return (
    status === "available" ||
    status === "downloading" ||
    status === "downloaded" ||
    status === "ready" ||
    status === "installing" ||
    status === "applying" ||
    status === "relaunching"
  );
}

function getUpdaterTooltip(state: AppUpdaterState | null, isActionPending: boolean, localError: string | null): string {
  if (localError) {
    return localError;
  }
  if (isActionPending) {
    return "Preparando atualização...";
  }

  const status = normalizeUpdaterStatus(state);
  if (status === "available") {
    return state?.latestVersion
      ? `Atualização ${state.latestVersion} disponível. Clique para atualizar.`
      : "Atualização disponível. Clique para atualizar.";
  }
  if (status === "downloading") {
    const progress = Number(state?.progressPercent ?? 0);
    if (Number.isFinite(progress) && progress > 0) {
      return `Baixando atualização (${Math.round(progress)}%).`;
    }
    return "Baixando atualização...";
  }
  if (status === "downloaded" || status === "ready") {
    return "Atualização pronta! Clique para reiniciar e atualizar.";
  }
  if (status === "installing" || status === "applying" || status === "relaunching") {
    return "Instalando atualização...";
  }
  return "";
}

export default function TopBar({ section = "friends", onPrepareForUpdateInstall }: TopBarProps) {
  const isDesktopRuntime = typeof window !== "undefined" && Boolean(window.electronAPI);
  const [updaterState, setUpdaterState] = useState<AppUpdaterState | null>(null);
  const [isUpdaterActionPending, setIsUpdaterActionPending] = useState(false);
  const [updaterActionError, setUpdaterActionError] = useState<string | null>(null);
  const lastUpdaterBackgroundCheckAtRef = useRef(0);
  const updaterStatus = normalizeUpdaterStatus(updaterState);

  const runBackgroundUpdaterCheck = useCallback(async (): Promise<void> => {
    if (!isDesktopRuntime) {
      return;
    }
    const api = window.electronAPI;
    if (!api?.updaterCheck) {
      return;
    }

    const nowMs = Date.now();
    if (nowMs - lastUpdaterBackgroundCheckAtRef.current < UPDATER_BACKGROUND_CHECK_MIN_INTERVAL_MS) {
      return;
    }
    if (
      isUpdaterActionPending ||
      updaterStatus === "checking" ||
      updaterStatus === "downloading" ||
      updaterStatus === "installing" ||
      updaterStatus === "applying" ||
      updaterStatus === "relaunching"
    ) {
      return;
    }

    lastUpdaterBackgroundCheckAtRef.current = nowMs;
    try {
      const checkedState = await api.updaterCheck();
      setUpdaterState(checkedState);
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn("[topbar:updater:background-check]", error);
      }
    }
  }, [isDesktopRuntime, isUpdaterActionPending, updaterStatus]);

  useEffect(() => {
    if (!isDesktopRuntime) {
      return;
    }

    const api = window.electronAPI;
    if (!api?.updaterGetState) {
      return;
    }

    let cancelled = false;
    void api.updaterGetState()
      .then((state) => {
        if (!cancelled) {
          setUpdaterState(state);
        }
      })
      .catch((error: unknown) => {
        if (import.meta.env.DEV) {
          console.warn("[topbar:updater:get-state]", error);
        }
      });

    const unsubscribe = api.onUpdaterStateChanged?.((state) => {
      if (cancelled) {
        return;
      }
      setUpdaterState(state);
      setUpdaterActionError(null);
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [isDesktopRuntime]);

  useEffect(() => {
    if (!isDesktopRuntime) {
      return;
    }

    void runBackgroundUpdaterCheck();

    const handleWindowFocus = (): void => {
      void runBackgroundUpdaterCheck();
    };
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        void runBackgroundUpdaterCheck();
      }
    };

    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isDesktopRuntime, runBackgroundUpdaterCheck]);

  const handleUpdaterAction = useCallback(async (): Promise<void> => {
    const api = window.electronAPI;
    if (!api || isUpdaterActionPending) {
      return;
    }

    const updaterStatus = normalizeUpdaterStatus(updaterState);
    if (
      updaterStatus === "downloading" ||
      updaterStatus === "installing" ||
      updaterStatus === "applying" ||
      updaterStatus === "relaunching"
    ) {
      return;
    }

    setUpdaterActionError(null);
    setIsUpdaterActionPending(true);

    try {
      if (updaterStatus === "available") {
        if (onPrepareForUpdateInstall) {
          await onPrepareForUpdateInstall();
        }

        if (api.updaterInstall) {
          await api.updaterInstall();
          return;
        }

        const fallbackDownloadResult = await api.updaterDownload?.();
        if (fallbackDownloadResult?.state) {
          setUpdaterState(fallbackDownloadResult.state);
        }
        return;
      }

      if (updaterStatus === "downloaded" || updaterStatus === "ready") {
        if (onPrepareForUpdateInstall) {
          await onPrepareForUpdateInstall();
        }

        await api.updaterInstall?.();
        return;
      }

      if (api.updaterCheck) {
        const checkedState = await api.updaterCheck();
        setUpdaterState(checkedState);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "");
      setUpdaterActionError(message || "Falha ao atualizar o aplicativo.");
    } finally {
      setIsUpdaterActionPending(false);
    }
  }, [isUpdaterActionPending, onPrepareForUpdateInstall, updaterState]);

  const showUpdaterAction = isDesktopRuntime && (isUpdateActionVisible(updaterStatus) || Boolean(updaterActionError));
  const updaterTooltip = useMemo(
    () => getUpdaterTooltip(updaterState, isUpdaterActionPending, updaterActionError),
    [isUpdaterActionPending, updaterActionError, updaterState],
  );
  const updaterIsBusy =
    updaterStatus === "downloading" ||
    updaterStatus === "installing" ||
    updaterStatus === "applying" ||
    updaterStatus === "relaunching" ||
    isUpdaterActionPending;
  const updaterIsAvailable = updaterStatus === "available";
  const updaterIsReady = updaterStatus === "downloaded" || updaterStatus === "ready";
  const updaterButtonLabel = updaterIsReady
    ? "Atualização pronta"
    : updaterIsAvailable
      ? "Atualização disponível"
      : "Atualização do aplicativo";

  return (
    <header className={`app-top-bar${isDesktopRuntime ? " app-top-bar--desktop" : ""}`}>
      <div className="app-top-bar__context" aria-label={`Secao atual: ${getSectionLabel(section)}`}>
        {section === "directMessages" ? (
          <img className="app-top-bar__context-icon app-top-bar__context-icon--chat" src={chatIconSrc} alt="" aria-hidden="true" />
        ) : (
          <MaterialSymbolIcon
            className="app-top-bar__context-icon"
            name={getSectionIconName(section)}
            size={18}
            filled
          />
        )}
        <span className="app-top-bar__context-text">{getSectionLabel(section)}</span>
      </div>
      <div className="app-top-bar__drag-region" aria-hidden="true" />
      {isDesktopRuntime ? (
        <div className="app-top-bar__actions">
          {showUpdaterAction ? (
            <Tooltip text={updaterTooltip} position="bottom" delay={120} disabled={!updaterTooltip}>
              <button
                type="button"
                className={`app-top-bar__icon-btn app-top-bar__icon-btn--updater${
                  updaterIsAvailable ? " app-top-bar__icon-btn--updater-available" : ""
                }${updaterIsReady ? " app-top-bar__icon-btn--updater-ready" : ""}`}
                onClick={() => {
                  void handleUpdaterAction();
                }}
                aria-label={updaterButtonLabel}
                data-updater-tooltip={updaterTooltip}
              >
                <MaterialSymbolIcon
                  name={updaterIsBusy ? "sync" : "download"}
                  size={18}
                  className={`${updaterIsBusy ? "app-top-bar__spin " : ""}${
                    updaterIsReady ? "app-top-bar__updater-icon--ready" : ""
                  }${updaterIsAvailable ? "app-top-bar__updater-icon--available" : ""}`}
                />
                {updaterIsAvailable || updaterIsReady ? <span className="app-top-bar__badge-dot" aria-hidden="true" /> : null}
              </button>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
