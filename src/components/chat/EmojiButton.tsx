import type { RefObject } from "react";
import MaterialSymbolIcon from "../ui/MaterialSymbolIcon";

interface EmojiButtonProps {
  buttonRef: RefObject<HTMLButtonElement>;
  isOpen: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

export default function EmojiButton({ buttonRef, isOpen, disabled = false, onToggle }: EmojiButtonProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`dm-chat__composer-emoji${isOpen ? " dm-chat__composer-emoji--active" : ""}`}
      aria-label="Emojis"
      aria-expanded={isOpen}
      title="Emojis"
      disabled={disabled}
      onMouseDown={(event) => {
        // Keep focus behavior stable in the message input.
        event.preventDefault();
      }}
      onClick={onToggle}
    >
      <MaterialSymbolIcon name="mood" size={19} />
    </button>
  );
}
