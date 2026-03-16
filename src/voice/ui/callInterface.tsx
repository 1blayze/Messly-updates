import type {
  VoiceConnectionState,
  VoiceDiagnosticsPeerSnapshot,
  VoiceParticipantState,
} from "../client/webrtc";
import VoiceMicToggleButton from "../../components/voice/VoiceMicToggleButton";
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
  void isConnecting;
  void connectionState;
  void elapsedSeconds;
  void diagnostics;
  void errorMessage;
  void microphoneWarning;

  if (!isOpen) {
    return null;
  }

  const sortedParticipants = [...participants].sort((left, right) => Number(right.isLocal) - Number(left.isLocal));
  const avatarParticipants = sortedParticipants.slice(0, 2);

  return (
    <aside className="voice-call-panel" aria-label="Chamada de voz">
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
                src={participant.avatarSrc}
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
