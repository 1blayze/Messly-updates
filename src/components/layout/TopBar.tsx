import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MaterialSymbolIcon from "../ui/MaterialSymbolIcon";
import "../../styles/components/TopBar.css";

interface TopBarProps {
  isCallActive?: boolean;
  onPrepareForUpdateInstall?: () => Promise<void> | void;
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
    return "Atualizacao";
  }
  switch (state.status) {
    case "checking":
      return "Verificando atualizacao";
    case "available":
      return "Atualizacao disponivel";
    case "downloading":
      return "Baixando atualizacao";
    case "downloaded":
      return "Pronta para instalar";
    case "error":
      return "Falha ao atualizar";
    case "disabled":
      return "Atualizador desativado";
    default:
      return "Atualizacao";
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
      return "system_update_alt";
    case "error":
      return "error";
    default:
      return "system_update_alt";
  }
}

function shouldShowUpdaterButton(state: AppUpdaterState | null, isPanelOpen: boolean): boolean {
  if (typeof window === "undefined" || !window.electronAPI?.updaterGetState) {
    return false;
  }
  if (!state) {
    return false;
  }
  if (isPanelOpen) {
    return true;
  }
  return ["checking", "available", "downloading", "downloaded", "error"].includes(state.status);
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
  if (normalized.includes("no published versions on github")) {
    return "Nenhuma versao publicada foi encontrada no repositorio de atualizacoes.";
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

export default function TopBar({ isCallActive = false, onPrepareForUpdateInstall }: TopBarProps) {
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
      setLocalActionError("Falha ao verificar atualizacao.");
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
      setLocalActionError("Falha ao baixar atualizacao.");
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
        "Voce esta em uma chamada. Ao atualizar, voce sera desconectado. Deseja continuar?",
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
      setLocalActionError("Falha ao iniciar instalacao.");
      setIsUpdaterActionPending(false);
    }
  }, [isCallActive, onPrepareForUpdateInstall]);

  const updaterProgressText = useMemo(() => {
    if (!updaterState || updaterState.status !== "downloading") {
      return "";
    }
    return `${Math.round(updaterState.progressPercent)}% · ${formatBytes(updaterState.downloadedBytes)} / ${formatBytes(
      updaterState.totalBytes,
    )}`;
  }, [updaterState]);

  const updaterBodyText = useMemo(() => {
    if (!updaterState) {
      return "";
    }
    if (updaterState.status === "available") {
      return updaterState.latestVersion
        ? `Versao ${updaterState.latestVersion} pronta para download.`
        : "Nova versao disponivel para download.";
    }
    if (updaterState.status === "downloaded") {
      return "Atualizacao baixada. Clique para instalar e reiniciar.";
    }
    if (updaterState.status === "checking") {
      return "Buscando a ultima versao no repositorio.";
    }
    if (updaterState.status === "unavailable") {
      return updaterState.latestVersion
        ? `Voce ja esta na versao ${updaterState.latestVersion}.`
        : "Nenhuma atualizacao encontrada.";
    }
    if (updaterState.status === "disabled") {
      return getSafeUpdaterUiErrorMessage(updaterState.errorMessage, "Atualizador desativado.");
    }
    if (updaterState.status === "error") {
      return getSafeUpdaterUiErrorMessage(updaterState.errorMessage, "Falha ao verificar atualizacao.");
    }
    if (updaterState.status === "downloading") {
      return updaterProgressText;
    }
    return "";
  }, [updaterProgressText, updaterState]);

  const showUpdaterButton = shouldShowUpdaterButton(updaterState, isUpdaterPanelOpen);
  const isDownloading = updaterState?.status === "downloading";
  const canDownload = updaterState?.status === "available";
  const canInstall = updaterState?.status === "downloaded";
  const canCheck = updaterState?.status !== "downloading";

  return (
    <header className="app-top-bar">
      <div className="app-top-bar__drag-region" aria-hidden="true" />
      <div className="app-top-bar__actions">
        {showUpdaterButton ? (
          <div ref={panelRef} className="app-top-bar__updater">
            <button
              type="button"
              className={`app-top-bar__icon-btn app-top-bar__icon-btn--updater${
                isUpdaterPanelOpen ? " app-top-bar__icon-btn--active" : ""
              }${isDownloading ? " app-top-bar__icon-btn--busy" : ""}`}
              onClick={() => {
                setIsUpdaterPanelOpen((current) => !current);
              }}
              aria-label={getUpdaterTitle(updaterState)}
              title={getUpdaterTitle(updaterState)}
            >
              <MaterialSymbolIcon
                name={getUpdaterActionIcon(updaterState)}
                size={18}
                filled={updaterState?.status !== "error"}
                className={isDownloading ? "app-top-bar__spin" : undefined}
              />
              {updaterState?.status === "available" ? <span className="app-top-bar__badge-dot" aria-hidden="true" /> : null}
            </button>

            {isUpdaterPanelOpen ? (
              <div className="app-top-bar__updater-panel" role="dialog" aria-label="Atualizacao do aplicativo">
                <div className="app-top-bar__updater-header">
                  <div>
                    <p className="app-top-bar__updater-title">{getUpdaterTitle(updaterState)}</p>
                    {updaterState?.latestVersion ? (
                      <p className="app-top-bar__updater-subtitle">
                        {updaterState.currentVersion} → {updaterState.latestVersion}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="app-top-bar__panel-close"
                    onClick={() => setIsUpdaterPanelOpen(false)}
                    aria-label="Fechar painel de atualizacao"
                  >
                    <MaterialSymbolIcon name="close" size={16} filled={false} />
                  </button>
                </div>

                {updaterBodyText ? <p className="app-top-bar__updater-body">{updaterBodyText}</p> : null}

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
                    Ao instalar, voce sera desconectado da chamada atual.
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
