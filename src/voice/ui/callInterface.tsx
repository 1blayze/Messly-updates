import MaterialSymbolIcon from "../../components/ui/MaterialSymbolIcon";
import type {
  VoiceConnectionState,
  VoiceDiagnosticsPeerSnapshot,
  VoiceParticipantState,
} from "../client/webrtc";
import "../../styles/components/VoiceCallInterface.css";

export interface VoiceCallInterfaceProps {
  isOpen: boolean;
  isConnecting: boolean;
  connectionState: VoiceConnectionState;
  participants: VoiceParticipantState[];
  localMuted: boolean;
  elapsedSeconds: number | null;
  diagnostics: VoiceDiagnosticsPeerSnapshot[];
  errorMessage?: string | null;
  microphoneWarning?: string | null;
  onToggleMute: () => void;
  onLeave: () => void;
}

function formatElapsed(secondsRaw: number | null): string {
  if (!secondsRaw || secondsRaw < 0) {
    return "00:00";
  }

  const seconds = Math.floor(secondsRaw);
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

function formatMetric(value: number | null, suffix: string): string {
  if (value == null || !Number.isFinite(value)) {
    return "--";
  }
  return `${value}${suffix}`;
}

function formatTimeMetric(value: number | null): string {
  if (value == null || !Number.isFinite(value)) {
    return "--";
  }
  if (value <= 0) {
    return "<1 ms";
  }
  const rounded = value >= 10 ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded} ms`;
}

function getConnectionLabel(state: VoiceConnectionState): string {
  switch (state) {
    case "connecting":
      return "Conectando";
    case "connected":
      return "Conectado";
    case "reconnecting":
      return "Reconectando";
    case "closed":
      return "Encerrado";
    case "idle":
    default:
      return "Aguardando";
  }
}

function formatConnectionQuality(value: "excellent" | "good" | "fair" | "poor" | "unknown"): string {
  switch (value) {
    case "excellent":
      return "Excelente";
    case "good":
      return "Boa";
    case "fair":
      return "Media";
    case "poor":
      return "Ruim";
    case "unknown":
    default:
      return "Desconhecida";
  }
}

export default function VoiceCallInterface({
  isOpen,
  isConnecting,
  connectionState,
  participants,
  localMuted,
  elapsedSeconds,
  diagnostics,
  errorMessage,
  microphoneWarning,
  onToggleMute,
  onLeave,
}: VoiceCallInterfaceProps) {
  if (!isOpen) {
    return null;
  }

  return (
    <aside className="voice-call-panel" aria-label="Chamada de voz">
      <header className="voice-call-panel__header">
        <div className="voice-call-panel__header-copy">
          <p className="voice-call-panel__title">Canal de voz</p>
          <p className="voice-call-panel__subtitle">
            {getConnectionLabel(connectionState)} | {formatElapsed(elapsedSeconds)}
          </p>
        </div>
      </header>

      {errorMessage ? <p className="voice-call-panel__error">{errorMessage}</p> : null}
      {microphoneWarning ? <p className="voice-call-panel__warning">{microphoneWarning}</p> : null}

      <section className="voice-call-panel__participants" aria-label="Participantes da chamada">
        {participants.map((participant) => {
          const speakingClass = participant.speaking ? " voice-call-participant--speaking" : "";
          const mutedClass = participant.muted ? " voice-call-participant--muted" : "";
          const normalizedLevel = Math.max(0, Math.min(1, participant.speakingLevel));
          return (
            <article
              key={participant.userId}
              className={`voice-call-participant${speakingClass}${mutedClass}`}
              aria-label={`${participant.displayName}${participant.speaking ? " falando" : ""}`}
            >
              <div className="voice-call-participant__avatar-wrap">
                <img
                  className="voice-call-participant__avatar"
                  src={participant.avatarSrc}
                  alt={`Avatar de ${participant.displayName}`}
                  loading="lazy"
                />
                {participant.speaking ? (
                  <span
                    className="voice-call-participant__speaking-ring"
                    style={{
                      opacity: Math.max(0.45, Math.min(1, normalizedLevel)),
                    }}
                    aria-hidden="true"
                  />
                ) : null}
              </div>
              <div className="voice-call-participant__meta">
                <p className="voice-call-participant__name">
                  {participant.displayName}
                  {participant.isLocal ? " (Voce)" : ""}
                </p>
                <p className="voice-call-participant__status">
                  {participant.muted ? "Microfone mutado" : "Microfone ativo"} | {participant.connectionState}
                </p>
                <div className="voice-call-participant__level-meter" aria-hidden="true">
                  <span
                    className="voice-call-participant__level-fill"
                    style={{
                      width: `${Math.max(2, Math.round(normalizedLevel * 100))}%`,
                    }}
                  />
                </div>
              </div>
            </article>
          );
        })}
      </section>

      <section className="voice-call-panel__controls" aria-label="Controles da chamada">
        <button
          type="button"
          className={`voice-call-panel__control-btn${localMuted ? " voice-call-panel__control-btn--active" : ""}`}
          onClick={onToggleMute}
          disabled={isConnecting}
          aria-label={localMuted ? "Desmutar microfone" : "Mutar microfone"}
          title={localMuted ? "Desmutar microfone" : "Mutar microfone"}
        >
          <MaterialSymbolIcon name={localMuted ? "mic_off" : "mic"} size={18} />
          <span>{localMuted ? "Desmutar" : "Mutar"}</span>
        </button>
        <button
          type="button"
          className="voice-call-panel__control-btn voice-call-panel__control-btn--danger"
          onClick={onLeave}
          aria-label="Sair da chamada"
          title="Sair da chamada"
        >
          <MaterialSymbolIcon name="close" size={18} />
          <span>Sair</span>
        </button>
      </section>

      <section className="voice-call-panel__debug" aria-label="Diagnostico da conexao">
        <p className="voice-call-panel__debug-title">Diagnostico (WebRTC)</p>
        {diagnostics.length === 0 ? (
          <p className="voice-call-panel__debug-empty">Coletando metricas...</p>
        ) : (
          <div className="voice-call-panel__debug-list">
            {diagnostics.map((row) => (
              <article key={row.userId} className="voice-call-panel__debug-row">
                <p className="voice-call-panel__debug-user">{row.userId}</p>
                <p className="voice-call-panel__debug-metric">Ping: {formatTimeMetric(row.pingMs)}</p>
                <p className="voice-call-panel__debug-metric">Latencia: {formatTimeMetric(row.latencyMs)}</p>
                <p className="voice-call-panel__debug-metric">Jitter: {formatTimeMetric(row.jitterMs)}</p>
                <p className="voice-call-panel__debug-metric">Loss: {formatMetric(row.packetLossPercent, "%")}</p>
                <p className="voice-call-panel__debug-metric">In: {formatMetric(row.inboundBitrateKbps, " kbps")}</p>
                <p className="voice-call-panel__debug-metric">Out: {formatMetric(row.outboundBitrateKbps, " kbps")}</p>
                <p className="voice-call-panel__debug-metric">Qualidade: {formatConnectionQuality(row.connectionQuality)}</p>
              </article>
            ))}
          </div>
        )}
      </section>
    </aside>
  );
}
