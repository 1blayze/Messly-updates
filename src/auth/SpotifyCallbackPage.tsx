import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthSession } from "./AuthProvider";
import { completeSpotifyOAuthCallbackCode } from "../services/connections/spotifyConnection";

const SETTINGS_AUTO_OPEN_SECTION_KEY = "messly:settings:auto-open-section";

type CallbackStatus = "processing" | "success" | "error" | "handoff";

function buildDesktopHandoffUrl(params: URLSearchParams): string {
  const handoff = new URL("messly://callback");
  const code = String(params.get("code") ?? "").trim();
  const state = String(params.get("state") ?? "").trim();
  const error = String(params.get("error") ?? "").trim();
  const errorDescription = String(params.get("error_description") ?? "").trim();

  if (code) {
    handoff.searchParams.set("code", code);
  }
  if (state) {
    handoff.searchParams.set("state", state);
  }
  if (error) {
    handoff.searchParams.set("error", error);
  }
  if (errorDescription) {
    handoff.searchParams.set("error_description", errorDescription);
  }

  return handoff.toString();
}

export default function SpotifyCallbackPage() {
  const navigate = useNavigate();
  const { user, isLoading } = useAuthSession();
  const [status, setStatus] = useState<CallbackStatus>("processing");
  const [message, setMessage] = useState("Concluindo conexao com Spotify...");
  const hasHandledRef = useRef(false);

  const searchParams = useMemo(() => {
    if (typeof window === "undefined") {
      return new URLSearchParams();
    }
    return new URLSearchParams(window.location.search);
  }, []);

  useEffect(() => {
    if (hasHandledRef.current) {
      return;
    }
    hasHandledRef.current = true;

    const error = String(searchParams.get("error") ?? "").trim();
    const errorDescription = String(searchParams.get("error_description") ?? "").trim();
    const code = String(searchParams.get("code") ?? "").trim();
    const state = String(searchParams.get("state") ?? "").trim();

    // Popup flow for web settings: notify opener and close.
    if (typeof window !== "undefined" && window.opener && !window.opener.closed) {
      try {
        window.opener.postMessage(
          {
            type: "messly:spotify:oauth-callback",
            url: window.location.href,
          },
          window.location.origin,
        );
      } catch {
        // Ignore opener communication failures.
      }

      if (!error) {
        setStatus("success");
        setMessage("Conexao recebida. Voce ja pode fechar esta janela.");
      } else {
        setStatus("error");
        setMessage(errorDescription || error || "Spotify retornou um erro ao autorizar a conexao.");
      }

      window.setTimeout(() => {
        try {
          window.close();
        } catch {
          // Ignore close failures.
        }
      }, 350);
      return;
    }

    if (error) {
      setStatus("error");
      setMessage(errorDescription || error || "Spotify retornou um erro ao autorizar a conexao.");
      return;
    }

    if (!code || !state) {
      setStatus("error");
      setMessage("Callback do Spotify invalido. Tente conectar novamente.");
      return;
    }

    // Browser callback with no active Azyoon session: handoff to desktop app.
    if (typeof window !== "undefined" && !user && !isLoading) {
      const handoffUrl = buildDesktopHandoffUrl(searchParams);
      setStatus("handoff");
      setMessage("Abrindo o aplicativo Azyoon para concluir a conexao...");
      window.location.href = handoffUrl;
      return;
    }

    if (!user || isLoading) {
      setStatus("processing");
      setMessage("Aguardando sessao do Azyoon para concluir a conexao...");
      hasHandledRef.current = false;
      return;
    }

    void (async () => {
      try {
        await completeSpotifyOAuthCallbackCode(user.uid, code, state);
        if (typeof window !== "undefined") {
          window.sessionStorage.setItem(SETTINGS_AUTO_OPEN_SECTION_KEY, "connections");
        }
        setStatus("success");
        setMessage("Conta do Spotify conectada com sucesso.");
        navigate("/settings/connections", { replace: true });
      } catch (connectError) {
        const fallbackMessage =
          connectError instanceof Error && connectError.message.trim()
            ? connectError.message.trim()
            : "Nao foi possivel concluir a conexao com Spotify.";

        if (!user && typeof window !== "undefined") {
          const handoffUrl = buildDesktopHandoffUrl(searchParams);
          setStatus("handoff");
          setMessage("Abrindo o aplicativo Azyoon para concluir a conexao...");
          window.location.href = handoffUrl;
          return;
        }

        setStatus("error");
        setMessage(fallbackMessage);
      }
    })();
  }, [isLoading, navigate, searchParams, user]);

  return (
    <div className="auth-page">
      <div className="auth-card" role="status" aria-live="polite">
        <h1 className="auth-title auth-title--welcome">
          {status === "success"
            ? "Spotify conectado"
            : status === "error"
              ? "Falha na conexao"
              : status === "handoff"
                ? "Abrindo o Azyoon"
                : "Conectando Spotify"}
        </h1>
        <p className="auth-subtitle">{message}</p>
      </div>
    </div>
  );
}
