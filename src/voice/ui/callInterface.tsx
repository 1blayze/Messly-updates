import type {
  VoiceConnectionState,
  VoiceDiagnosticsPeerSnapshot,
  VoiceParticipantState,
} from "../client/webrtc";
import "../../styles/components/VoiceCallInterface.css";

const micIconUrl = new URL("../../assets/icons/ui/Microphone 1.svg", import.meta.url).href;
const micOffIconUrl = new URL("../../assets/icons/ui/Microphone Off.svg", import.meta.url).href;
const cameraIconUrl = new URL("../../assets/icons/ui/Video.svg", import.meta.url).href;
const screenIconUrl = new URL("../../assets/icons/ui/screen.svg", import.meta.url).href;
const endCallIconUrl = new URL("../../assets/icons/ui/Call-Missed.svg", import.meta.url).href;

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

export default function VoiceCallInterface({
  isOpen,
  isConnecting,
  participants,
  localMuted,
  connectionState,
  elapsedSeconds,
  diagnostics,
  errorMessage,
  microphoneWarning,
  onToggleMute,
  onLeave,
}: VoiceCallInterfaceProps) {
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
        {avatarParticipants.map((participant) => (
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
          </div>
        ))}
      </section>

      <section className="voice-call-panel__controls" aria-label="Controles da chamada">
        <button
          type="button"
          className={`voice-call-panel__control-btn${localMuted ? " voice-call-panel__control-btn--active" : ""}`}
          onClick={onToggleMute}
          aria-label={localMuted ? "Desmutar microfone" : "Mutar microfone"}
          title={localMuted ? "Desmutar microfone" : "Mutar microfone"}
        >
          <img
            className="voice-call-panel__control-icon"
            src={localMuted ? micOffIconUrl : micIconUrl}
            alt=""
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          className="voice-call-panel__control-btn"
          aria-label="Video em breve"
          title="Video em breve"
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
          title="Transmitir tela em breve"
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
          title="Sair da chamada"
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
