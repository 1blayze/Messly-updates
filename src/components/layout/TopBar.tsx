import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MaterialSymbolIcon from "../ui/MaterialSymbolIcon";
import Tooltip from "../ui/Tooltip";
import chatIconSrc from "../../assets/icons/ui/Chat.svg";
import "../../styles/components/TopBar.css";

interface TopBarProps {
  section?: "friends" | "directMessages";
  isCallActive?: boolean;
  onPrepareForUpdateInstall?: () => Promise<void> | void;
}

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

function formatBytes(value: number): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  }
  const gb = mb / 1024;
  return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
}

function getUpdaterTitle(state: AppUpdaterState | null): string {
  if (!state) {
    return "Atualização";
  }
  switch (state.status) {
    case "checking":
      return "Verificando atualização";
    case "available":
      return "Atualização disponível";
    case "downloading":
      return "Baixando atualização";
    case "downloaded":
      return "Pronta para instalar";
    case "error":
      return "Falha ao atualizar";
    case "disabled":
      return "Atualizador desativado";
    default:
      return "Atualização";
  }
}

function getUpdaterActionIcon(state: AppUpdaterState | null): string {
  if (!state) {
    return "system_update_alt";
  }
  switch (state.status) {
    case "checking":
      return "sync";
    case "available":
      return "download";
    case "downloading":
      return "downloading";
    case "downloaded":
      return "download";
    case "error":
      return "error";
    default:
      return "system_update_alt";
  }
}

function getUpdaterTooltipLabel(state: AppUpdaterState | null): string {
  if (!state) {
    return "";
  }

  switch (state.status) {
    case "downloaded":
      return "Atualiza\u00e7\u00e3o pronta!";
    case "available":
      return "Atualiza\u00e7\u00e3o dispon\u00edvel";
    default:
      return "";
  }
}

function isNoPublishedUpdateErrorMessage(rawMessage: string | null | undefined): boolean {
  const normalized = String(rawMessage ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.includes("no published versions on github")) {
    return true;
  }
  return normalized.includes("latest version on github") && (
    normalized.includes("production release exists") ||
    normalized.includes("release exists")
  );
}

function shouldShowUpdaterButton(state: AppUpdaterState | null, isPanelOpen: boolean): boolean {
  if (typeof window === "undefined" || !window.electronAPI?.updaterGetState) {
    return false;
  }
  if (isPanelOpen) {
    return true;
  }
  if (!state) {
    return true;
  }
  return state.status !== "disabled" || Boolean(state.errorMessage);
}

function logUpdaterConsoleError(context: string, error: unknown): void {
  if (typeof console === "undefined" || typeof console.error !== "function") {
    return;
  }
  console.error(`[updater] ${context}`, error);
}

function getSafeUpdaterUiErrorMessage(rawMessage: string | null | undefined, fallbackMessage: string): string {
  const message = String(rawMessage ?? "").trim();
  if (!message) {
    return fallbackMessage;
  }
  const normalized = message.toLowerCase();
  if (isNoPublishedUpdateErrorMessage(message)) {
    return "Nenhuma versão publicada foi encontrada no repositório de atualizações.";
  }
  if (
    normalized.includes("error invoking remote method") ||
    normalized.includes("updater:check") ||
    normalized.includes("updater:download") ||
    normalized.includes("updater:install")
  ) {
    return fallbackMessage;
  }
  return message;
}

export default function TopBar({ section = "friends", isCallActive = false, onPrepareForUpdateInstall }: TopBarProps) {
  const isDesktopRuntime = typeof window !== "undefined" && Boolean(window.electronAPI);
  const [updaterState, setUpdaterState] = useState<AppUpdaterState | null>(null);
  const [isUpdaterPanelOpen, setIsUpdaterPanelOpen] = useState(false);
  const [isUpdaterActionPending, setIsUpdaterActionPending] = useState(false);
  const [localActionError, setLocalActionError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
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
      .catch((error) => {
        logUpdaterConsoleError("get-state failed", error);
      });

    const unsubscribe = api.onUpdaterStateChanged?.((state) => {
      if (!cancelled) {
        setUpdaterState(state);
        setLocalActionError(null);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!isUpdaterPanelOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (panelRef.current?.contains(target)) {
        return;
      }
      setIsUpdaterPanelOpen(false);
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [isUpdaterPanelOpen]);

  const handleCheckUpdates = useCallback(async (): Promise<void> => {
    const api = window.electronAPI;
    if (!api?.updaterCheck) {
      return;
    }
    setLocalActionError(null);
    setIsUpdaterActionPending(true);
    try {
      const nextState = await api.updaterCheck();
      setUpdaterState(nextState);
    } catch (error) {
      logUpdaterConsoleError("check failed", error);
      setLocalActionError("Falha ao verificar atualização.");
    } finally {
      setIsUpdaterActionPending(false);
    }
  }, []);

  const handleDownloadUpdate = useCallback(async (): Promise<void> => {
    const api = window.electronAPI;
    if (!api?.updaterDownload) {
      return;
    }
    setLocalActionError(null);
    setIsUpdaterActionPending(true);
    try {
      const result = await api.updaterDownload();
      if (result?.state) {
        setUpdaterState(result.state);
      }
    } catch (error) {
      logUpdaterConsoleError("download failed", error);
      setLocalActionError("Falha ao baixar atualização.");
    } finally {
      setIsUpdaterActionPending(false);
    }
  }, []);

  const handleInstallUpdate = useCallback(async (): Promise<void> => {
    const api = window.electronAPI;
    if (!api?.updaterInstall) {
      return;
    }
    setLocalActionError(null);

    if (isCallActive) {
      const confirmed = window.confirm(
        "Você está em uma chamada. Ao atualizar, você será desconectado. Deseja continuar?",
      );
      if (!confirmed) {
        return;
      }
      try {
        await onPrepareForUpdateInstall?.();
      } catch {}
    }

    setIsUpdaterActionPending(true);
    try {
      await api.updaterInstall();
    } catch (error) {
      logUpdaterConsoleError("install failed", error);
      setLocalActionError("Falha ao iniciar instalação.");
      setIsUpdaterActionPending(false);
    }
  }, [isCallActive, onPrepareForUpdateInstall]);

  const updaterProgressText = useMemo(() => {
    if (!updaterState || updaterState.status !== "downloading") {
      return "";
    }
    return `${Math.round(updaterState.progressPercent)}% - ${formatBytes(updaterState.downloadedBytes)} / ${formatBytes(
      updaterState.totalBytes,
    )}`;
  }, [updaterState]);

  const updaterBodyText = useMemo(() => {
    if (!updaterState) {
      return "Clique em Verificar para buscar atualizações.";
    }
    if (updaterState.status === "available") {
      return updaterState.latestVersion
        ? `Versão ${updaterState.latestVersion} pronta para download.`
        : "Nova versão disponível para download.";
    }
    if (updaterState.status === "downloaded") {
      return "Atualização baixada. Clique para instalar e reiniciar.";
    }
    if (updaterState.status === "checking") {
      return "Buscando a última versão no repositório.";
    }
    if (updaterState.status === "unavailable") {
      return updaterState.latestVersion
        ? `Você já está na versão ${updaterState.latestVersion}.`
        : "Nenhuma atualização encontrada.";
    }
    if (updaterState.status === "disabled") {
      return getSafeUpdaterUiErrorMessage(updaterState.errorMessage, "Atualizador desativado.");
    }
    if (updaterState.status === "error") {
      return getSafeUpdaterUiErrorMessage(updaterState.errorMessage, "Falha ao verificar atualização.");
    }
    if (updaterState.status === "downloading") {
      return updaterProgressText;
    }
    return "";
  }, [updaterProgressText, updaterState]);

  const showUpdaterButton = shouldShowUpdaterButton(updaterState, isUpdaterPanelOpen);
  const isDownloading = updaterState?.status === "downloading";
  const isUpdateReady = updaterState?.status === "downloaded";
  const isUpdateAvailable = updaterState?.status === "available";
  const canDownload = updaterState?.status === "available";
  const canInstall = updaterState?.status === "downloaded";
  const canCheck = updaterState?.status !== "downloading";
  const updaterTooltipLabel = getUpdaterTooltipLabel(updaterState);

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
      <div className="app-top-bar__actions">
        {showUpdaterButton ? (
          <div ref={panelRef} className="app-top-bar__updater">
            <Tooltip
              text={updaterTooltipLabel}
              position="bottom"
              delay={120}
              disabled={isUpdaterPanelOpen || !updaterTooltipLabel}
            >
              <button
                type="button"
                className={`app-top-bar__icon-btn app-top-bar__icon-btn--updater${
                  isUpdaterPanelOpen ? " app-top-bar__icon-btn--active" : ""
                }${isDownloading ? " app-top-bar__icon-btn--busy" : ""}${
                  isUpdateReady ? " app-top-bar__icon-btn--updater-ready" : ""
                }${isUpdateAvailable ? " app-top-bar__icon-btn--updater-available" : ""}`}
                onClick={() => {
                  setIsUpdaterPanelOpen((current) => !current);
                }}
                aria-label={getUpdaterTitle(updaterState)}
              >
                <MaterialSymbolIcon
                  name={getUpdaterActionIcon(updaterState)}
                  size={18}
                  filled={updaterState?.status !== "error"}
                  className={`${isDownloading ? "app-top-bar__spin " : ""}${
                    isUpdateReady ? "app-top-bar__updater-icon--ready" : ""
                  }${isUpdateAvailable ? "app-top-bar__updater-icon--available" : ""}`}
                />
              </button>
            </Tooltip>

            {isUpdaterPanelOpen ? (
              <div className="app-top-bar__updater-panel" role="dialog" aria-label="Atualização do aplicativo">
                <div className="app-top-bar__updater-header">
                  <div>
                    <p className="app-top-bar__updater-title">{getUpdaterTitle(updaterState)}</p>
                    {updaterState?.latestVersion ? (
                      <p className="app-top-bar__updater-subtitle">
                        {updaterState.currentVersion} {"->"} {updaterState.latestVersion}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="app-top-bar__panel-close"
                    onClick={() => setIsUpdaterPanelOpen(false)}
                    aria-label="Fechar painel de atualização"
                  >
                    <MaterialSymbolIcon name="close" size={16} filled={false} />
                  </button>
                </div>

                {updaterBodyText ? <p className="app-top-bar__updater-body">{updaterBodyText}</p> : null}
                {localActionError ? <p className="app-top-bar__updater-error">{localActionError}</p> : null}

                {updaterState?.status === "downloading" ? (
                  <div className="app-top-bar__progress">
                    <div
                      className="app-top-bar__progress-fill"
                      style={{ width: `${Math.max(0, Math.min(100, updaterState.progressPercent))}%` }}
                    />
                  </div>
                ) : null}

                {isCallActive && canInstall ? (
                  <p className="app-top-bar__updater-warning">
                    Ao instalar, você será desconectado da chamada atual.
                  </p>
                ) : null}

                <div className="app-top-bar__updater-actions-row">
                  <button
                    type="button"
                    className="app-top-bar__panel-btn app-top-bar__panel-btn--ghost"
                    onClick={() => void handleCheckUpdates()}
                    disabled={isUpdaterActionPending || !canCheck}
                  >
                    Verificar
                  </button>
                  {canDownload ? (
                    <button
                      type="button"
                      className="app-top-bar__panel-btn app-top-bar__panel-btn--primary"
                      onClick={() => void handleDownloadUpdate()}
                      disabled={isUpdaterActionPending}
                    >
                      Baixar
                    </button>
                  ) : null}
                  {canInstall ? (
                    <button
                      type="button"
                      className="app-top-bar__panel-btn app-top-bar__panel-btn--primary"
                      onClick={() => void handleInstallUpdate()}
                      disabled={isUpdaterActionPending}
                    >
                      Atualizar
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </header>
  );
}
