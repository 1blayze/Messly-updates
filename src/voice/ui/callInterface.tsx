import type {
  VoiceConnectionState,
  VoiceDiagnosticsPeerSnapshot,
  VoiceParticipantState,
} from "../client/webrtc";
import VoiceMicToggleButton from "../../components/voice/VoiceMicToggleButton";
import { getNameAvatarUrl } from "../../services/cdn/mediaUrls";
import "../../styles/components/VoiceCallInterface.css";

const micOffIconUrl = new URL("../../assets/icons/ui/Microphone Off.svg", import.meta.url).href;
const deafenIconUrl = new URL("../../assets/icons/ui/deafen.svg", import.meta.url).href;
const cameraIconUrl = new URL("../../assets/icons/ui/Video.svg", import.meta.url).href;
const screenIconUrl = new URL("../../assets/icons/ui/screen.svg", import.meta.url).href;
const endCallIconUrl = new URL("../../assets/icons/ui/Call-Missed.svg", import.meta.url).href;

export interface VoiceCallInterfaceProps {
  isOpen: boolean;
  isConnecting: boolean;
  connectionState: VoiceConnectionState;
  participants: VoiceParticipantState[];
  localMuted: boolean;
  localDeafened: boolean;
  elapsedSeconds: number | null;
  diagnostics: VoiceDiagnosticsPeerSnapshot[];
  errorMessage?: string | null;
  microphoneWarning?: string | null;
  onToggleMute: () => void;
  onLeave: () => void;
}

const CONNECTION_STATE_LABELS: Record<VoiceConnectionState, string> = {
  idle: "Em espera",
  connecting: "Conectando...",
  connected: "Conectado",
  reconnecting: "Reconectando...",
  closed: "Encerrada",
};

const CONNECTION_QUALITY_RANK: Record<VoiceDiagnosticsPeerSnapshot["connectionQuality"], number> = {
  poor: 0,
  fair: 1,
  good: 2,
  excellent: 3,
  unknown: 4,
};

function formatElapsedLabel(elapsedSeconds: number | null): string {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds == null || elapsedSeconds < 0) {
    return "--:--";
  }
  const wholeSeconds = Math.floor(elapsedSeconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const seconds = wholeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatDiagnosticsValue(value: number | null, suffix: string): string {
  if (!Number.isFinite(value) || value == null) {
    return "--";
  }
  const rounded = Math.abs(value) >= 10 ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded}${suffix}`;
}

export default function VoiceCallInterface({
  isOpen,
  isConnecting,
  participants,
  localMuted,
  localDeafened,
  connectionState,
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

  const sortedParticipants = [...participants].sort((left, right) => Number(right.isLocal) - Number(left.isLocal));
  const avatarParticipants = sortedParticipants.slice(0, 2);
  const participantsLabel = participants.length === 1
    ? "1 participante"
    : `${participants.length} participantes`;
  const connectionStateLabel = isConnecting
    ? CONNECTION_STATE_LABELS.connecting
    : CONNECTION_STATE_LABELS[connectionState];
  const elapsedLabel = formatElapsedLabel(elapsedSeconds);
  const hasDiagnostics = diagnostics.length > 0;
  const prioritizedDiagnostics = [...diagnostics].sort((left, right) => {
    const qualityDelta = CONNECTION_QUALITY_RANK[left.connectionQuality] - CONNECTION_QUALITY_RANK[right.connectionQuality];
    if (qualityDelta !== 0) {
      return qualityDelta;
    }

    const leftPing = left.pingMs ?? Number.POSITIVE_INFINITY;
    const rightPing = right.pingMs ?? Number.POSITIVE_INFINITY;
    return leftPing - rightPing;
  });
  const primaryDiagnostic = prioritizedDiagnostics[0] ?? null;
  const diagnosticsTone = primaryDiagnostic?.connectionQuality === "poor" || primaryDiagnostic?.connectionQuality === "fair"
    ? "voice-call-panel__diagnostics--warn"
    : "";

  return (
    <aside className="voice-call-panel" aria-label="Chamada de voz">
      <header className="voice-call-panel__meta" aria-live="polite">
        <span className={`voice-call-panel__state${isConnecting ? " voice-call-panel__state--connecting" : ""}`}>
          {connectionStateLabel}
        </span>
        <span className="voice-call-panel__elapsed">{elapsedLabel}</span>
      </header>
      <p className="voice-call-panel__participants-label">{participantsLabel}</p>
      {errorMessage ? (
        <p className="voice-call-panel__notice voice-call-panel__notice--error" role="status">
          {errorMessage}
        </p>
      ) : null}
      {!errorMessage && microphoneWarning ? (
        <p className="voice-call-panel__notice voice-call-panel__notice--warning" role="status">
          {microphoneWarning}
        </p>
      ) : null}
      {hasDiagnostics && primaryDiagnostic ? (
        <p className={`voice-call-panel__diagnostics ${diagnosticsTone}`}>
          Ping {formatDiagnosticsValue(primaryDiagnostic.pingMs, "ms")}
          {" • "}
          Jitter {formatDiagnosticsValue(primaryDiagnostic.jitterMs, "ms")}
          {" • "}
          Perda {formatDiagnosticsValue(primaryDiagnostic.packetLossPercent, "%")}
        </p>
      ) : null}
      <section className="voice-call-panel__avatars" aria-label="Participantes da chamada">
        {avatarParticipants.map((participant) => {
          const participantMuted = participant.isLocal ? localMuted : participant.muted;
          const participantDeafened = participant.isLocal ? localDeafened : participant.deafened;
          const showDeafened = participantDeafened;
          const showMuted = participantMuted && !participantDeafened;
          const statusIconUrl = showDeafened
            ? deafenIconUrl
            : (showMuted ? micOffIconUrl : "");
          const statusLabel = showDeafened
            ? "Usuario ensurdecido"
            : (showMuted ? "Usuario mutado" : "");

          return (
            <div
              key={participant.userId}
              className={`voice-call-panel__avatar-wrap${participant.speaking ? " voice-call-panel__avatar-wrap--speaking" : ""}`}
            >
              <img
                className="voice-call-panel__avatar"
                src={participant.avatarSrc || getNameAvatarUrl(participant.displayName || "U")}
                alt={`Avatar de ${participant.displayName}`}
                loading="eager"
                decoding="sync"
              />
              {statusIconUrl ? (
                <span className="voice-call-panel__avatar-status" role="img" aria-label={statusLabel}>
                  <img className="voice-call-panel__avatar-status-icon" src={statusIconUrl} alt="" aria-hidden="true" />
                </span>
              ) : null}
            </div>
          );
        })}
      </section>

      <section className="voice-call-panel__controls" aria-label="Controles da chamada">
        <VoiceMicToggleButton
          isMicEnabled={!localMuted}
          className={`voice-call-panel__control-btn${localMuted ? " voice-call-panel__control-btn--active" : ""}`}
          onClick={onToggleMute}
        />
        <button
          type="button"
          className="voice-call-panel__control-btn"
          aria-label="Video em breve"
          data-tooltip="Video em breve"
          disabled
        >
          <img
            className="voice-call-panel__control-icon"
            src={cameraIconUrl}
            alt=""
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          className="voice-call-panel__control-btn"
          aria-label="Transmitir tela em breve"
          data-tooltip="Transmitir tela em breve"
          disabled
        >
          <img
            className="voice-call-panel__control-icon"
            src={screenIconUrl}
            alt=""
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          className="voice-call-panel__control-btn voice-call-panel__control-btn--danger"
          onClick={onLeave}
          aria-label="Sair da chamada"
          data-tooltip="Sair da chamada"
        >
          <img
            className="voice-call-panel__control-icon"
            src={endCallIconUrl}
            alt=""
            aria-hidden="true"
          />
        </button>
      </section>
    </aside>
  );
}
