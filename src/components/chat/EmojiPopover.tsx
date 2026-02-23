import { useCallback, useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import EmojiPicker, { EmojiStyle, Theme, type EmojiClickData } from "emoji-picker-react";

interface EmojiPopoverProps {
  isOpen: boolean;
  anchorRef: RefObject<HTMLElement>;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

interface PopoverPosition {
  top: number;
  left: number;
  width: number;
  height: number;
}

const EMOJI_POPOVER_WIDTH = 460;
const EMOJI_POPOVER_HEIGHT = 380;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP_ABOVE = 18;
const ANCHOR_GAP_BELOW = 10;

export default function EmojiPopover({ isOpen, anchorRef, onSelect, onClose }: EmojiPopoverProps) {
  const [position, setPosition] = useState<PopoverPosition>({
    top: VIEWPORT_MARGIN,
    left: VIEWPORT_MARGIN,
    width: EMOJI_POPOVER_WIDTH,
    height: EMOJI_POPOVER_HEIGHT,
  });

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) {
      return;
    }

    const rect = anchor.getBoundingClientRect();
    const popoverWidth = Math.min(
      EMOJI_POPOVER_WIDTH,
      Math.max(300, window.innerWidth - VIEWPORT_MARGIN * 2),
    );
    const popoverHeight = Math.min(
      EMOJI_POPOVER_HEIGHT,
      Math.max(280, window.innerHeight - VIEWPORT_MARGIN * 2),
    );

    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - popoverWidth - VIEWPORT_MARGIN);
    const preferredLeft = rect.right - popoverWidth;
    const left = Math.min(Math.max(preferredLeft, VIEWPORT_MARGIN), maxLeft);

    const preferredTop = rect.top - popoverHeight - ANCHOR_GAP_ABOVE;
    const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - popoverHeight - VIEWPORT_MARGIN);
    const top =
      preferredTop >= VIEWPORT_MARGIN
        ? preferredTop
        : Math.min(Math.max(rect.bottom + ANCHOR_GAP_BELOW, VIEWPORT_MARGIN), maxTop);

    setPosition({ top, left, width: popoverWidth, height: popoverHeight });
  }, [anchorRef]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    updatePosition();
    const handleReposition = () => {
      updatePosition();
    };

    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);
    return () => {
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
    };
  }, [isOpen, updatePosition]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }

      const anchor = anchorRef.current;
      if (anchor?.contains(target)) {
        return;
      }

      const popover = document.getElementById("dm-chat-emoji-popover");
      if (popover?.contains(target)) {
        return;
      }

      onClose();
    };

    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("touchstart", handlePointerDown, { passive: true });
    window.addEventListener("keydown", handleEsc);

    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("touchstart", handlePointerDown);
      window.removeEventListener("keydown", handleEsc);
    };
  }, [anchorRef, isOpen, onClose]);

  if (!isOpen || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      id="dm-chat-emoji-popover"
      className="dm-chat__emoji-popover emojiPopover"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
        width: `${position.width}px`,
        height: `${position.height}px`,
      }}
      role="dialog"
      aria-label="Seletor de emojis"
    >
      <EmojiPicker
        onEmojiClick={(emojiData: EmojiClickData) => {
          onSelect(emojiData.emoji);
          onClose();
        }}
        autoFocusSearch={false}
        searchPlaceholder="Buscar"
        searchPlaceHolder="Buscar"
        searchClearButtonLabel="Limpar"
        searchDisabled={false}
        skinTonesDisabled
        lazyLoadEmojis
        previewConfig={{ showPreview: false }}
        emojiStyle={EmojiStyle.NATIVE}
        theme={Theme.DARK}
        width="100%"
        height="100%"
      />
    </div>,
    document.body,
  );
}
