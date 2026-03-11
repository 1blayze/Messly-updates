import { useEffect, useRef } from "react";
import MaterialSymbolIcon from "../ui/MaterialSymbolIcon";
import AvatarImage from "../ui/AvatarImage";
import type { CallMode } from "../../services/calls/callApi";

interface StreamVideoProps {
  className: string;
  stream: MediaStream | null;
  muted?: boolean;
  autoPlay?: boolean;
}

function StreamVideo({ className, stream, muted = false, autoPlay = true }: StreamVideoProps) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    element.srcObject = stream;
    if (autoPlay && stream) {
      void element.play().catch(() => {
        // ignore autoplay issues
      });
    }

    return () => {
      if (element.srcObject === stream) {
        element.srcObject = null;
      }
    };
  }, [autoPlay, stream]);

  return <video ref={ref} className={className} autoPlay={autoPlay} muted={muted} playsInline />;
}

interface IncomingCallOverlayProps {
  isOpen: boolean;
  callerName: string;
  callerAvatarSrc: string;
  mode: CallMode;
  onAccept: () => void;
  onDecline: () => void;
}

export function IncomingCallOverlay({
  isOpen,
  callerName,
  callerAvatarSrc,
  mode,
  onAccept,
  onDecline,
}: IncomingCallOverlayProps) {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="dm-call dm-call--incoming" role="dialog" aria-modal="true" aria-label="Chamada recebida">
      <div className="dm-call__panel">
        <p className="dm-call__eyebrow">{mode === "video" ? "Chamada de vídeo recebida" : "Chamada de voz recebida"}</p>
        <AvatarImage className="dm-call__avatar" src={callerAvatarSrc} name={callerName} alt={`Avatar de ${callerName}`} />
        <h3 className="dm-call__name">{callerName}</h3>
        <div className="dm-call__actions">
          <button type="button" className="dm-call__btn dm-call__btn--accept" onClick={onAccept}>
            <MaterialSymbolIcon name="call" size={20} />
            Aceitar
          </button>
          <button type="button" className="dm-call__btn dm-call__btn--decline" onClick={onDecline}>
            <MaterialSymbolIcon name="call_end" size={20} />
            Recusar
          </button>
        </div>
      </div>
    </div>
  );
}

interface OutgoingCallOverlayProps {
  isOpen: boolean;
  calleeName: string;
  calleeAvatarSrc: string;
  mode: CallMode;
  onCancel: () => void;
}

export function OutgoingCallOverlay({
  isOpen,
  calleeName,
  calleeAvatarSrc,
  mode,
  onCancel,
}: OutgoingCallOverlayProps) {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="dm-call dm-call--outgoing" role="dialog" aria-modal="true" aria-label="Chamada em andamento">
      <div className="dm-call__panel">
        <p className="dm-call__eyebrow">{mode === "video" ? "Chamando por vídeo..." : "Chamando por voz..."}</p>
        <AvatarImage className="dm-call__avatar" src={calleeAvatarSrc} name={calleeName} alt={`Avatar de ${calleeName}`} />
        <h3 className="dm-call__name">{calleeName}</h3>
        <div className="dm-call__actions">
          <button type="button" className="dm-call__btn dm-call__btn--decline" onClick={onCancel}>
            <MaterialSymbolIcon name="call_end" size={20} />
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

interface InCallOverlayProps {
  isOpen: boolean;
  mode: CallMode;
  statusLabel: string;
  remoteStream: MediaStream | null;
  localStream: MediaStream | null;
  isMicEnabled: boolean;
  isCameraEnabled: boolean;
  isScreenSharing: boolean;
  callErrorText?: string | null;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onHangup: () => void;
}

export function InCallOverlay({
  isOpen,
  mode,
  statusLabel,
  remoteStream,
  localStream,
  isMicEnabled,
  isCameraEnabled,
  isScreenSharing,
  callErrorText,
  onToggleMute,
  onToggleCamera,
  onToggleScreenShare,
  onHangup,
}: InCallOverlayProps) {
  if (!isOpen) {
    return null;
  }

  const hasLocalVideo = Boolean(localStream && localStream.getVideoTracks().length > 0);

  return (
    <div className="dm-call dm-call--active" role="dialog" aria-modal="true" aria-label="Chamada ativa">
      <div className="dm-call__stage">
        {remoteStream ? (
          <StreamVideo className="dm-call__remote-video" stream={remoteStream} />
        ) : (
          <div className="dm-call__remote-placeholder">
            <MaterialSymbolIcon name={mode === "video" ? "videocam" : "call"} size={34} />
            <span>{statusLabel}</span>
          </div>
        )}

        {hasLocalVideo ? (
          <StreamVideo className="dm-call__local-video" stream={localStream} muted />
        ) : null}

        <div className="dm-call__status-wrap">
          <p className="dm-call__status">{statusLabel}</p>
          {callErrorText ? <p className="dm-call__error">{callErrorText}</p> : null}
        </div>

        <div className="dm-call__control-bar">
          <button
            type="button"
            className={`dm-call__control${isMicEnabled ? "" : " dm-call__control--off"}`}
            onClick={onToggleMute}
            aria-label={isMicEnabled ? "Silenciar microfone" : "Ativar microfone"}
            data-tooltip={isMicEnabled ? "Silenciar" : "Ativar"}
          >
            <MaterialSymbolIcon name={isMicEnabled ? "mic" : "mic_off"} size={20} />
          </button>

          {mode === "video" ? (
            <button
              type="button"
              className={`dm-call__control${isCameraEnabled ? "" : " dm-call__control--off"}`}
              onClick={onToggleCamera}
              aria-label={isCameraEnabled ? "Desligar câmera" : "Ligar câmera"}
              data-tooltip={isCameraEnabled ? "Desligar câmera" : "Ligar câmera"}
            >
              <MaterialSymbolIcon name={isCameraEnabled ? "videocam" : "videocam_off"} size={20} />
            </button>
          ) : null}

          {mode === "video" ? (
            <button
              type="button"
              className={`dm-call__control${isScreenSharing ? " dm-call__control--active" : ""}`}
              onClick={onToggleScreenShare}
              aria-label={isScreenSharing ? "Parar transmissão" : "Compartilhar tela"}
              data-tooltip={isScreenSharing ? "Parar transmissão" : "Compartilhar tela"}
            >
              <MaterialSymbolIcon name={isScreenSharing ? "stop_screen_share" : "screen_share"} size={20} />
            </button>
          ) : null}

          <button
            type="button"
            className="dm-call__control dm-call__control--hangup"
            onClick={onHangup}
            aria-label="Desconectar"
            data-tooltip="Desconectar"
          >
            <MaterialSymbolIcon name="call_end" size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}
