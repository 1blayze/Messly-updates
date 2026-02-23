import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from "react";
import styles from "./ImageEditModal.module.css";

interface BannerCropperProps {
  imageSrc: string;
  imageStyle: CSSProperties;
  imageClassName?: string;
  viewportRef: RefObject<HTMLDivElement>;
  isDragging: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

export default function BannerCropper({
  imageSrc,
  imageStyle,
  imageClassName,
  viewportRef,
  isDragging,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: BannerCropperProps) {
  return (
    <div
      className={`${styles.stage} ${styles.stageBanner} ${styles.cropperRoot}${isDragging ? ` ${styles.stageDragging}` : ""}`}
    >
      {imageSrc ? (
        <>
          <div
            className={styles.imageLayer}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <div ref={viewportRef} className={styles.bannerViewport}>
              <img className={imageClassName ?? styles.viewportImage} style={imageStyle} src={imageSrc} alt="Preview do banner" />
            </div>
          </div>
          <div className={styles.overlayLayer} aria-hidden="true">
            <span className={styles.bannerMask} />
          </div>
          <div className={styles.frameLayer} aria-hidden="true">
            <span className={styles.bannerFrame} />
          </div>
        </>
      ) : (
        <div className={styles.stagePlaceholder}>Carregando imagem...</div>
      )}
    </div>
  );
}
