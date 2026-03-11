import { useEffect } from "react";
import { useAuthSession } from "../auth/AuthProvider";
import { appBootstrap } from "../core/appBootstrap";

const UI_PROTECTION_ENABLED = import.meta.env.PROD;

function isTextInputElement(element: Element | null): boolean {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

function isEditableElement(element: Element | null): boolean {
  if (!element) {
    return false;
  }

  if (isTextInputElement(element)) {
    return true;
  }

  if (element instanceof HTMLElement && element.isContentEditable) {
    return true;
  }

  return Boolean(
    element.closest('[contenteditable="true"], [contenteditable="plaintext-only"], [data-allow-selection="true"]'),
  );
}

function resolveEventElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) {
    return target;
  }

  return target instanceof Node ? target.parentElement : null;
}

export default function MesslyRuntimeBootstrap() {
  const { authReady, user } = useAuthSession();

  useEffect(() => {
    if (!UI_PROTECTION_ENABLED) {
      return;
    }

    document.body.dataset.uiLockdown = "true";

    const handleCopy = (event: ClipboardEvent): void => {
      const selectionObject = window.getSelection();
      const selection = selectionObject?.toString();
      if (!selection) {
        return;
      }

      const activeElement = document.activeElement;
      if (isEditableElement(activeElement)) {
        return;
      }

      const target = resolveEventElement(event.target);
      if (isEditableElement(target)) {
        return;
      }

      const anchorNode = selectionObject?.anchorNode ?? null;
      const anchorElement = anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement ?? null;
      if (isEditableElement(anchorElement)) {
        return;
      }

      event.preventDefault();
    };

    const handleContextMenu = (event: MouseEvent): void => {
      const target = resolveEventElement(event.target);
      if (isEditableElement(target)) {
        return;
      }

      event.preventDefault();
    };

    document.addEventListener("copy", handleCopy);
    window.addEventListener("contextmenu", handleContextMenu);
    return () => {
      document.removeEventListener("copy", handleCopy);
      window.removeEventListener("contextmenu", handleContextMenu);
      delete document.body.dataset.uiLockdown;
    };
  }, []);

  useEffect(() => {
    if (!authReady) {
      return;
    }

    const currentUserId = String(user?.uid ?? "").trim();
    if (!currentUserId) {
      appBootstrap.resetForGuest();
      return;
    }

    void appBootstrap.start(currentUserId);
  }, [authReady, user?.uid]);

  return null;
}
