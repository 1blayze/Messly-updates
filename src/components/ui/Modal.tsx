import { useEffect, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import MaterialSymbolIcon from "./MaterialSymbolIcon";
import styles from "./Modal.module.css";

interface ModalProps {
  isOpen: boolean;
  title?: string;
  ariaLabel?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  panelClassName?: string;
  bodyClassName?: string;
  closeOnBackdrop?: boolean;
  showCloseButton?: boolean;
}

export default function Modal({
  isOpen,
  title,
  ariaLabel,
  onClose,
  children,
  footer,
  panelClassName,
  bodyClassName,
  closeOnBackdrop = true,
  showCloseButton = true,
}: ModalProps) {
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  const handleBackdropMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    if (!closeOnBackdrop) {
      return;
    }

    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  return createPortal(
    <div
      className={styles.backdrop}
      role="presentation"
      data-messly-modal-root="true"
      onMouseDown={handleBackdropMouseDown}
      onTouchStart={(event) => {
        event.stopPropagation();
      }}
    >
      <section
        className={`${styles.panel}${panelClassName ? ` ${panelClassName}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? title ?? "Modal"}
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
        onTouchStart={(event) => {
          event.stopPropagation();
        }}
      >
        {title || showCloseButton ? (
          <header className={styles.header}>
            {title ? <h2 className={styles.title}>{title}</h2> : <span />}
            {showCloseButton ? (
              <button className={styles.closeButton} type="button" onClick={onClose} aria-label="Fechar">
                <MaterialSymbolIcon name="close" size={18} />
              </button>
            ) : null}
          </header>
        ) : null}

        <div className={`${styles.body}${bodyClassName ? ` ${bodyClassName}` : ""}`}>{children}</div>

        {footer ? <footer className={styles.footer}>{footer}</footer> : null}
      </section>
    </div>,
    document.body,
  );
}
