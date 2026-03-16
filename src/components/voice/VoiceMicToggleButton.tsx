import MaterialSymbolIcon from "../ui/MaterialSymbolIcon";

interface VoiceMicToggleButtonProps {
  isMicEnabled: boolean;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
}

export default function VoiceMicToggleButton({
  isMicEnabled,
  onClick,
  className,
  disabled = false,
}: VoiceMicToggleButtonProps) {
  const tooltipLabel = isMicEnabled ? "Silenciar microfone" : "Ativar microfone";

  return (
    <button
      className={className}
      type="button"
      aria-label={tooltipLabel}
      data-tooltip={tooltipLabel}
      onClick={onClick}
      disabled={disabled}
    >
      <MaterialSymbolIcon name={isMicEnabled ? "mic" : "mic_off"} size={18} />
    </button>
  );
}
