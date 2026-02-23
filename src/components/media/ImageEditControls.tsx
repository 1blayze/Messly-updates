import MaterialSymbolIcon from "../ui/MaterialSymbolIcon";
import styles from "./ImageEditModal.module.css";

interface ImageEditControlsProps {
  zoom: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  errorMessage?: string | null;
  onZoomChange: (value: number) => void;
  onReset: () => void;
  onRotate: () => void;
}

export default function ImageEditControls({
  zoom,
  min = 1,
  max = 2.5,
  step = 0.05,
  disabled = false,
  errorMessage,
  onZoomChange,
  onReset,
  onRotate,
}: ImageEditControlsProps) {
  return (
    <>
      <div className={styles.controls}>
        <MaterialSymbolIcon name="image" size={18} />
        <input
          className={styles.zoomRange}
          type="range"
          min={min}
          max={max}
          step={step}
          value={zoom}
          onChange={(event) => onZoomChange(Number(event.target.value))}
          aria-label="Nivel de zoom"
          disabled={disabled}
        />
        <button
          className={styles.controlIconButton}
          type="button"
          onClick={onRotate}
          aria-label="Rotacionar imagem"
          disabled={disabled}
        >
          <MaterialSymbolIcon name="restart_alt" size={18} />
        </button>
      </div>

      {errorMessage ? <p className={styles.error}>{errorMessage}</p> : null}
    </>
  );
}
