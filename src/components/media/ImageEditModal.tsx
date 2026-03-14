import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { ProfileMediaKind } from "../../services/media/profileMediaUpload";
import Modal from "../ui/Modal";
import BannerCropper from "./BannerCropper";
import ImageEditControls from "./ImageEditControls";
import { exportCroppedImage, resolveCoverTransform } from "./exportCroppedImage";
import styles from "./ImageEditModal.module.css";

interface ImageEditModalProps {
  isOpen: boolean;
  kind: ProfileMediaKind;
  file: File | null;
  isApplying?: boolean;
  onClose: () => void;
  onApply: (file: File) => Promise<void> | void;
}

interface EditPreset {
  outputWidth: number;
  outputHeight: number;
  quality: number;
  mask: "circle" | "rectangle";
}

const PRESETS: Record<ProfileMediaKind, EditPreset> = {
  avatar: {
    outputWidth: 512,
    outputHeight: 512,
    quality: 0.92,
    mask: "circle",
  },
  banner: {
    outputWidth: 1200,
    outputHeight: 480,
    quality: 0.92,
    mask: "rectangle",
  },
};

const MAX_ZOOM = 4;

function isGifFile(file: File | null): boolean {
  if (!file) {
    return false;
  }
  const type = (file.type || "").toLowerCase();
  if (type === "image/gif") {
    return true;
  }
  return file.name.toLowerCase().endsWith(".gif");
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();

    image.onload = () => {
      resolve(image);
    };

    image.onerror = () => {
      reject(new Error("Não foi possível ler a imagem selecionada."));
    };

    image.src = src;
  });
}

export default function ImageEditModal({ isOpen, kind, file, isApplying = false, onClose, onApply }: ImageEditModalProps) {
  const preset = PRESETS[kind];
  const isAvatar = preset.mask === "circle";
  const isGif = useMemo(() => isGifFile(file), [file]);

  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [rotationDegrees, setRotationDegrees] = useState(0);
  const [sourceImage, setSourceImage] = useState<HTMLImageElement | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [isPreparing, setIsPreparing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [dragState, setDragState] = useState<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startPanX: number;
    startPanY: number;
  } | null>(null);

  const avatarViewportRef = useRef<HTMLDivElement>(null);
  const bannerViewportRef = useRef<HTMLDivElement>(null);
  const activeViewportRef = isAvatar ? avatarViewportRef : bannerViewportRef;

  useEffect(() => {
    if (!isOpen || !file) {
      setZoom(1);
      setPanX(0);
      setPanY(0);
      setRotationDegrees(0);
      setSourceImage(null);
      setSourceUrl("");
      setIsPreparing(false);
      setErrorMessage(null);
      setDragState(null);
      setFrameSize(null);
      return;
    }

    let isActive = true;
    setZoom(1);
    setPanX(0);
    setPanY(0);
    setRotationDegrees(0);
    setErrorMessage(null);
    setDragState(null);
    setSourceImage(null);

    const objectUrl = URL.createObjectURL(file);
    setSourceUrl(objectUrl);

    void loadImage(objectUrl)
      .then((image) => {
        if (isActive) {
          setSourceImage(image);
        }
      })
      .catch((error) => {
        if (isActive) {
          setSourceImage(null);
          setSourceUrl("");
          setErrorMessage(error instanceof Error ? error.message : "Não foi possível abrir a imagem.");
        }
      });

    return () => {
      isActive = false;
      URL.revokeObjectURL(objectUrl);
    };
  }, [file, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const viewport = activeViewportRef.current;
    if (!viewport) {
      return;
    }

    const applySize = (): void => {
      const rect = viewport.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setFrameSize({ width: rect.width, height: rect.height });
      }
    };

    applySize();
    const observer = new ResizeObserver(() => applySize());
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [activeViewportRef, isAvatar, isOpen, sourceUrl]);

  const targetFrame = useMemo(() => {
    if (frameSize) {
      return frameSize;
    }
    if (isAvatar) {
      return { width: 300, height: 300 };
    }
    return { width: 450, height: 180 };
  }, [frameSize, isAvatar]);

  const transform = useMemo(() => {
    if (!sourceImage) {
      return null;
    }
    return resolveCoverTransform(
      sourceImage.naturalWidth,
      sourceImage.naturalHeight,
      targetFrame.width,
      targetFrame.height,
      zoom,
      panX,
      panY,
      rotationDegrees,
    );
  }, [panX, panY, rotationDegrees, sourceImage, targetFrame.height, targetFrame.width, zoom]);

  useEffect(() => {
    if (!transform) {
      return;
    }
    if (transform.panX !== panX) {
      setPanX(transform.panX);
    }
    if (transform.panY !== panY) {
      setPanY(transform.panY);
    }
  }, [panX, panY, transform]);

  const imageStyle = useMemo<CSSProperties>(() => {
    if (!transform || !sourceImage) {
      return {};
    }
    return {
      width: `${sourceImage.naturalWidth}px`,
      height: `${sourceImage.naturalHeight}px`,
      transform: `translate3d(calc(-50% + ${transform.panX}px), calc(-50% + ${transform.panY}px), 0) scale(${transform.scale}) rotate(${transform.rotationDegrees}deg)`,
    };
  }, [sourceImage, transform]);

  const canApply = useMemo(() => {
    if (!file || !sourceUrl || isApplying || isPreparing) {
      return false;
    }
    if (isGif) {
      return true;
    }
    return Boolean(sourceImage && transform);
  }, [file, isApplying, isPreparing, isGif, sourceImage, sourceUrl, transform]);

  const handleApply = async (): Promise<void> => {
    if (!file || isApplying || isPreparing) {
      return;
    }

    setErrorMessage(null);
    setIsPreparing(true);

    try {
      if (isGif) {
        await onApply(file);
        return;
      }

      if (!sourceImage || !transform) {
        return;
      }

      const editedFile = await exportCroppedImage({
        image: sourceImage,
        fileName: file.name,
        frameWidth: targetFrame.width,
        frameHeight: targetFrame.height,
        outputWidth: preset.outputWidth,
        outputHeight: preset.outputHeight,
        zoom,
        panX,
        panY,
        rotationDegrees,
        mimeType: "image/webp",
        quality: preset.quality,
      });
      await onApply(editedFile);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Não foi possível aplicar a edição.");
    } finally {
      setIsPreparing(false);
    }
  };

  const handleStagePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (isGif || !sourceImage || isApplying || isPreparing || event.button !== 0) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    setDragState({
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPanX: panX,
      startPanY: panY,
    });
  };

  const handleStagePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!sourceImage || !dragState || event.pointerId !== dragState.pointerId || !transform) {
      return;
    }

    event.preventDefault();
    const dx = event.clientX - dragState.startClientX;
    const dy = event.clientY - dragState.startClientY;
    const nextPanX = dragState.startPanX + dx;
    const nextPanY = dragState.startPanY + dy;

    setPanX(Math.min(transform.maxPanX, Math.max(-transform.maxPanX, nextPanX)));
    setPanY(Math.min(transform.maxPanY, Math.max(-transform.maxPanY, nextPanY)));
  };

  const handleStagePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragState || event.pointerId !== dragState.pointerId) {
      return;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragState(null);
  };

  const footer = (
    <div className={styles.footerContent}>
      <button
        className={styles.resetButton}
        type="button"
        onClick={() => {
          setZoom(1);
          setPanX(0);
          setPanY(0);
          setRotationDegrees(0);
        }}
        disabled={isGif || isApplying || isPreparing}
      >
        Redefinir
      </button>

      <div className={styles.footerActions}>
        <button className={styles.cancelButton} type="button" onClick={onClose} disabled={isApplying || isPreparing}>
          Cancelar
        </button>
        <button className={styles.applyButton} type="button" onClick={() => void handleApply()} disabled={!canApply}>
          {isApplying || isPreparing ? "Salvando..." : "Salvar"}
        </button>
      </div>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      title="Editar imagem"
      ariaLabel="Editar imagem"
      onClose={onClose}
      panelClassName={styles.modalPanel}
      bodyClassName={styles.modalBody}
      footer={footer}
    >
      <div className={styles.editor}>
        {isAvatar ? (
          <div
            className={`${styles.stage} ${styles.stageAvatar}${dragState ? ` ${styles.stageDragging}` : ""}`}
            onPointerDown={handleStagePointerDown}
            onPointerMove={handleStagePointerMove}
            onPointerUp={handleStagePointerUp}
            onPointerCancel={handleStagePointerUp}
          >
            {sourceUrl ? (
              <div ref={avatarViewportRef} className={styles.avatarViewport}>
                <img className={`${styles.avatarImage} ${styles.stageImageGray}`} style={imageStyle} src={sourceUrl} alt="Prévia da imagem" />
                <img
                  className={`${styles.avatarImage} ${styles.stageImageColorCircle}`}
                  style={imageStyle}
                  src={sourceUrl}
                  alt="Prévia da imagem"
                />
                <span className={styles.circleGuide} aria-hidden="true" />
              </div>
            ) : (
              <div className={styles.stagePlaceholder}>Carregando imagem...</div>
            )}
          </div>
        ) : (
          <BannerCropper
            imageSrc={sourceUrl}
            imageStyle={imageStyle}
            imageClassName={styles.bannerImage}
            viewportRef={bannerViewportRef}
            isDragging={Boolean(dragState)}
            onPointerDown={handleStagePointerDown}
            onPointerMove={handleStagePointerMove}
            onPointerUp={handleStagePointerUp}
          />
        )}

        <ImageEditControls
          zoom={zoom}
          min={1}
          max={MAX_ZOOM}
          step={0.01}
          disabled={isGif || isApplying || isPreparing}
          infoMessage={isGif ? "Para manter a animacao, GIF sera enviado sem recorte." : null}
          errorMessage={errorMessage}
          onZoomChange={setZoom}
          onReset={() => {
            setZoom(1);
            setPanX(0);
            setPanY(0);
            setRotationDegrees(0);
          }}
          onRotate={() => setRotationDegrees((current) => (current + 90) % 360)}
        />
      </div>
    </Modal>
  );
}

