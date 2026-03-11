import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import "./Tooltip.css";

const TOOLTIP_INITIAL_DELAY_MS = 300;
const TOOLTIP_FAST_DELAY_MS = 300;
const TOOLTIP_RESET_DELAY_MS = 500;
const TOOLTIP_HIDE_DELAY_MS = 0;
const TOOLTIP_ANIMATION_MS = 120;
const TOOLTIP_OFFSET_PX = 10;
const TOOLTIP_VIEWPORT_MARGIN_PX = 8;

const TOOLTIP_SELECTOR = [
  "[data-messly-tooltip-content]",
  "[data-tooltip]",
  "[data-updater-tooltip]",
  "[title]",
].join(",");

type TooltipPlacement = "top" | "bottom" | "left" | "right" | "auto";
type ResolvedTooltipPlacement = Exclude<TooltipPlacement, "auto">;

interface TooltipRequest {
  anchorEl: HTMLElement;
  sourceEl: HTMLElement;
  content: ReactNode;
  preferredPlacement?: TooltipPlacement;
  delayMs?: number;
}

interface TooltipSnapshot extends TooltipRequest {
  id: string;
  isVisible: boolean;
}

interface TooltipPosition {
  top: number;
  left: number;
  placement: ResolvedTooltipPlacement;
}

interface TooltipContextValue {
  tooltipId: string | null;
  isSourceActive: (sourceEl: HTMLElement | null) => boolean;
  requestOpen: (request: TooltipRequest) => void;
  requestClose: (sourceEl?: HTMLElement | null, nextTarget?: EventTarget | null) => void;
  isWithinTooltip: (target: EventTarget | null) => boolean;
}

interface TooltipProviderProps {
  children: ReactNode;
}

interface TooltipProps {
  text?: string;
  content?: ReactNode;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
  position?: TooltipPlacement;
  delay?: number;
}

const TooltipContext = createContext<TooltipContextValue | null>(null);

function isElementWithinTooltip(target: EventTarget | null, tooltipEl: HTMLElement | null): boolean {
  return target instanceof Node && Boolean(tooltipEl?.contains(target));
}

function findTooltipTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) {
    return null;
  }
  return target.closest(TOOLTIP_SELECTOR) as HTMLElement | null;
}

interface ResolvedTooltipRequest {
  content: ReactNode;
  preferredPlacement: TooltipPlacement;
  delayMs: number | null;
}

function parseTooltipPlacement(value: string | null): TooltipPlacement {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  switch (normalized) {
    case "top":
    case "bottom":
    case "left":
    case "right":
    case "auto":
      return normalized;
    default:
      return "auto";
  }
}

function parseTooltipDelay(value: string | null): number | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.max(0, Math.min(2_000, Math.round(parsed)));
}

function readTooltipContent(target: HTMLElement): ResolvedTooltipRequest | null {
  const customContent = target.getAttribute("data-messly-tooltip-content");
  let resolvedContent: ReactNode | null = null;

  if (customContent && customContent.trim()) {
    resolvedContent = customContent.trim();
  }

  if (resolvedContent == null) {
    const dataTooltip = target.getAttribute("data-tooltip");
    if (dataTooltip && dataTooltip.trim()) {
      resolvedContent = dataTooltip.trim();
    }
  }

  if (resolvedContent == null) {
    const updaterTooltip = target.getAttribute("data-updater-tooltip");
    if (updaterTooltip && updaterTooltip.trim()) {
      resolvedContent = updaterTooltip.trim();
    }
  }

  if (resolvedContent == null) {
    const nativeTitle = target.getAttribute("title");
    if (nativeTitle && nativeTitle.trim()) {
      resolvedContent = nativeTitle.trim();
    }
  }

  if (resolvedContent == null) {
    return null;
  }

  return {
    content: resolvedContent,
    preferredPlacement: parseTooltipPlacement(
      target.getAttribute("data-tooltip-position") ?? target.getAttribute("data-tooltip-placement"),
    ),
    delayMs: parseTooltipDelay(target.getAttribute("data-tooltip-delay")),
  };
}

function mergeDescribedBy(currentValue: string | null, tooltipId: string): string {
  const parts = String(currentValue ?? "")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (!parts.includes(tooltipId)) {
    parts.push(tooltipId);
  }

  return parts.join(" ");
}

function computeCandidatePosition(
  anchorRect: DOMRect,
  tooltipRect: DOMRect,
  placement: ResolvedTooltipPlacement,
): TooltipPosition {
  const centeredLeft = anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2;
  const centeredTop = anchorRect.top + anchorRect.height / 2 - tooltipRect.height / 2;

  switch (placement) {
    case "bottom":
      return {
        placement,
        top: anchorRect.bottom + TOOLTIP_OFFSET_PX,
        left: centeredLeft,
      };
    case "left":
      return {
        placement,
        top: centeredTop,
        left: anchorRect.left - tooltipRect.width - TOOLTIP_OFFSET_PX,
      };
    case "right":
      return {
        placement,
        top: centeredTop,
        left: anchorRect.right + TOOLTIP_OFFSET_PX,
      };
    case "top":
    default:
      return {
        placement: "top",
        top: anchorRect.top - tooltipRect.height - TOOLTIP_OFFSET_PX,
        left: centeredLeft,
      };
  }
}

function doesPositionFitViewport(
  position: TooltipPosition,
  tooltipRect: DOMRect,
  viewportWidth: number,
  viewportHeight: number,
): boolean {
  return (
    position.left >= TOOLTIP_VIEWPORT_MARGIN_PX &&
    position.top >= TOOLTIP_VIEWPORT_MARGIN_PX &&
    position.left + tooltipRect.width <= viewportWidth - TOOLTIP_VIEWPORT_MARGIN_PX &&
    position.top + tooltipRect.height <= viewportHeight - TOOLTIP_VIEWPORT_MARGIN_PX
  );
}

function clampTooltipPosition(position: TooltipPosition, tooltipRect: DOMRect, viewportWidth: number, viewportHeight: number): TooltipPosition {
  const maxLeft = Math.max(TOOLTIP_VIEWPORT_MARGIN_PX, viewportWidth - tooltipRect.width - TOOLTIP_VIEWPORT_MARGIN_PX);
  const maxTop = Math.max(TOOLTIP_VIEWPORT_MARGIN_PX, viewportHeight - tooltipRect.height - TOOLTIP_VIEWPORT_MARGIN_PX);
  return {
    placement: position.placement,
    top: Math.max(TOOLTIP_VIEWPORT_MARGIN_PX, Math.min(position.top, maxTop)),
    left: Math.max(TOOLTIP_VIEWPORT_MARGIN_PX, Math.min(position.left, maxLeft)),
  };
}

function normalizePlacementOrder(primary: ResolvedTooltipPlacement): ResolvedTooltipPlacement[] {
  const fallbackOrder: ResolvedTooltipPlacement[] = ["top", "bottom", "right", "left"];
  return [primary, ...fallbackOrder.filter((placement) => placement !== primary)];
}

function computeTooltipPosition(
  anchorEl: HTMLElement,
  tooltipEl: HTMLElement,
  preferredPlacement: TooltipPlacement = "auto",
): TooltipPosition {
  const anchorRect = anchorEl.getBoundingClientRect();
  const tooltipRect = tooltipEl.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  const centeredLeft = anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2;
  const centeredRight = centeredLeft + tooltipRect.width;
  const nearLeftEdge = centeredLeft < TOOLTIP_VIEWPORT_MARGIN_PX;
  const nearRightEdge = centeredRight > viewportWidth - TOOLTIP_VIEWPORT_MARGIN_PX;

  let placements: ResolvedTooltipPlacement[];

  if ((preferredPlacement === "auto" || preferredPlacement === "top") && nearLeftEdge) {
    placements = ["right", "top", "bottom", "left"];
  } else if ((preferredPlacement === "auto" || preferredPlacement === "top") && nearRightEdge) {
    placements = ["left", "top", "bottom", "right"];
  } else {
    const primaryPlacement: ResolvedTooltipPlacement = preferredPlacement === "auto" ? "top" : preferredPlacement;
    placements = normalizePlacementOrder(primaryPlacement);
  }

  for (const placement of placements) {
    const candidate = computeCandidatePosition(anchorRect, tooltipRect, placement);
    if (doesPositionFitViewport(candidate, tooltipRect, viewportWidth, viewportHeight)) {
      return {
        ...candidate,
        top: Math.round(candidate.top),
        left: Math.round(candidate.left),
      };
    }
  }

  const fallbackCandidate = clampTooltipPosition(
    computeCandidatePosition(anchorRect, tooltipRect, placements[0]),
    tooltipRect,
    viewportWidth,
    viewportHeight,
  );
  return {
    ...fallbackCandidate,
    top: Math.round(fallbackCandidate.top),
    left: Math.round(fallbackCandidate.left),
  };
}

function areTooltipPositionsEqual(left: TooltipPosition, right: TooltipPosition): boolean {
  return left.top === right.top && left.left === right.left && left.placement === right.placement;
}

export function TooltipProvider({ children }: TooltipProviderProps) {
  const tooltipBaseId = useId();
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const resetTimerRef = useRef<number | null>(null);
  const exitTimerRef = useRef<number | null>(null);
  const warmStateRef = useRef(false);
  const idSequenceRef = useRef(0);
  const nativeTitleMapRef = useRef(new WeakMap<HTMLElement, string>());
  const ariaDescribedByMapRef = useRef(new WeakMap<HTMLElement, string | null>());
  const activeSourceRef = useRef<HTMLElement | null>(null);
  const activeAnchorRef = useRef<HTMLElement | null>(null);
  const pendingRequestRef = useRef<TooltipRequest | null>(null);
  const activeTooltipIdRef = useRef<string | null>(null);
  const [tooltip, setTooltip] = useState<TooltipSnapshot | null>(null);
  const [position, setPosition] = useState<TooltipPosition>({
    top: 0,
    left: 0,
    placement: "top",
  });

  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current != null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
  }, []);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current != null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current != null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  }, []);

  const clearExitTimer = useCallback(() => {
    if (exitTimerRef.current != null) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
  }, []);

  const restoreSourceAccessibility = useCallback((sourceEl: HTMLElement | null) => {
    if (!sourceEl) {
      return;
    }

    const previousTitle = nativeTitleMapRef.current.get(sourceEl);
    if (typeof previousTitle === "string" && !sourceEl.getAttribute("title")) {
      sourceEl.setAttribute("title", previousTitle);
    }
    nativeTitleMapRef.current.delete(sourceEl);

    const previousDescribedBy = ariaDescribedByMapRef.current.get(sourceEl);
    if (previousDescribedBy && previousDescribedBy.trim()) {
      sourceEl.setAttribute("aria-describedby", previousDescribedBy);
    } else {
      sourceEl.removeAttribute("aria-describedby");
    }
    ariaDescribedByMapRef.current.delete(sourceEl);
  }, []);

  const armWarmReset = useCallback(() => {
    clearResetTimer();
    resetTimerRef.current = window.setTimeout(() => {
      warmStateRef.current = false;
      resetTimerRef.current = null;
    }, TOOLTIP_RESET_DELAY_MS);
  }, [clearResetTimer]);

  const cleanupTooltipState = useCallback(() => {
    restoreSourceAccessibility(activeSourceRef.current);
    activeSourceRef.current = null;
    activeAnchorRef.current = null;
    pendingRequestRef.current = null;
    activeTooltipIdRef.current = null;
    armWarmReset();
  }, [armWarmReset, restoreSourceAccessibility]);

  const finalizeHide = useCallback(() => {
    const tooltipId = activeTooltipIdRef.current;
    if (!tooltipId) {
      return;
    }

    setTooltip((current) => {
      if (!current || current.id !== tooltipId) {
        return current;
      }
      return null;
    });
    cleanupTooltipState();
  }, [cleanupTooltipState]);

  const hideNow = useCallback(() => {
    const tooltipId = activeTooltipIdRef.current;
    clearShowTimer();
    clearHideTimer();

    if (!tooltipId) {
      clearExitTimer();
      cleanupTooltipState();
      return;
    }

    if (TOOLTIP_ANIMATION_MS <= 0) {
      clearExitTimer();
      finalizeHide();
      return;
    }

    setTooltip((current) => {
      if (!current || current.id !== activeTooltipIdRef.current) {
        return current;
      }
      if (!current.isVisible) {
        return current;
      }
      return { ...current, isVisible: false };
    });

    clearExitTimer();
    exitTimerRef.current = window.setTimeout(() => {
      clearExitTimer();
      finalizeHide();
    }, TOOLTIP_ANIMATION_MS);
  }, [cleanupTooltipState, clearExitTimer, clearHideTimer, clearShowTimer, finalizeHide]);

  const commitShow = useCallback((request: TooltipRequest) => {
    clearShowTimer();
    clearHideTimer();
    clearResetTimer();
    clearExitTimer();

    const normalizedContent = request.content;
    if (normalizedContent == null) {
      return;
    }

    if (activeSourceRef.current && activeSourceRef.current !== request.sourceEl) {
      restoreSourceAccessibility(activeSourceRef.current);
    }

    const nativeTitle = request.sourceEl.getAttribute("title");
    if (nativeTitle && !nativeTitleMapRef.current.has(request.sourceEl)) {
      nativeTitleMapRef.current.set(request.sourceEl, nativeTitle);
      request.sourceEl.removeAttribute("title");
    }

    if (!ariaDescribedByMapRef.current.has(request.sourceEl)) {
      ariaDescribedByMapRef.current.set(request.sourceEl, request.sourceEl.getAttribute("aria-describedby"));
    }

    activeSourceRef.current = request.sourceEl;
    activeAnchorRef.current = request.anchorEl;
    pendingRequestRef.current = null;
    warmStateRef.current = true;

    const nextId =
      tooltip && tooltip.sourceEl === request.sourceEl
        ? tooltip.id
        : `${tooltipBaseId.replace(/:/g, "")}-${++idSequenceRef.current}`;

    activeTooltipIdRef.current = nextId;

    request.sourceEl.setAttribute("aria-describedby", mergeDescribedBy(ariaDescribedByMapRef.current.get(request.sourceEl) ?? null, nextId));

    const shouldAnimateIn = !tooltip;
    setTooltip({
      id: nextId,
      anchorEl: request.anchorEl,
      sourceEl: request.sourceEl,
      content: normalizedContent,
      preferredPlacement: request.preferredPlacement ?? "auto",
      delayMs: request.delayMs,
      isVisible: !shouldAnimateIn,
    });

    if (shouldAnimateIn) {
      window.requestAnimationFrame(() => {
        setTooltip((current) => {
          if (!current || current.sourceEl !== request.sourceEl) {
            return current;
          }
          return { ...current, isVisible: true };
        });
      });
    }
  }, [clearExitTimer, clearHideTimer, clearResetTimer, clearShowTimer, restoreSourceAccessibility, tooltip, tooltipBaseId]);

  const requestOpen = useCallback((request: TooltipRequest) => {
    if (!request.anchorEl || !request.sourceEl || request.content == null) {
      return;
    }

    clearHideTimer();
    clearResetTimer();
    pendingRequestRef.current = request;

    const isSameSource =
      activeSourceRef.current === request.sourceEl &&
      activeAnchorRef.current === request.anchorEl &&
      tooltip;

    if (isSameSource) {
      clearShowTimer();
      clearExitTimer();
      setTooltip((current) => (
        current
          ? {
              ...current,
              content: request.content,
              preferredPlacement: request.preferredPlacement ?? "auto",
              delayMs: request.delayMs,
              isVisible: true,
            }
          : current
      ));
      return;
    }

    clearShowTimer();
    const explicitDelay = Number.isFinite(request.delayMs) ? Math.max(0, request.delayMs as number) : null;
    const showDelay =
      explicitDelay ?? (activeSourceRef.current || warmStateRef.current ? TOOLTIP_FAST_DELAY_MS : TOOLTIP_INITIAL_DELAY_MS);
    if (showDelay <= 0) {
      if (pendingRequestRef.current !== request) {
        return;
      }
      commitShow(request);
      return;
    }
    showTimerRef.current = window.setTimeout(() => {
      if (pendingRequestRef.current !== request) {
        return;
      }
      commitShow(request);
    }, showDelay);
  }, [clearExitTimer, clearHideTimer, clearResetTimer, clearShowTimer, commitShow, tooltip]);

  const isWithinTooltip = useCallback((target: EventTarget | null) => {
    return isElementWithinTooltip(target, tooltipRef.current);
  }, []);

  useEffect(() => {
    activeTooltipIdRef.current = tooltip?.id ?? null;
  }, [tooltip?.id]);

  const requestClose = useCallback((sourceEl?: HTMLElement | null, nextTarget?: EventTarget | null) => {
    const matchesActiveSource = !sourceEl || activeSourceRef.current === sourceEl || pendingRequestRef.current?.sourceEl === sourceEl;
    if (!matchesActiveSource) {
      return;
    }

    const normalizedNextTarget = nextTarget ?? null;
    if (sourceEl && normalizedNextTarget instanceof Node && sourceEl.contains(normalizedNextTarget)) {
      return;
    }

    clearShowTimer();
    clearHideTimer();

    if (TOOLTIP_HIDE_DELAY_MS <= 0) {
      hideNow();
      return;
    }

    hideTimerRef.current = window.setTimeout(() => {
      hideNow();
    }, TOOLTIP_HIDE_DELAY_MS);
  }, [clearHideTimer, clearShowTimer, hideNow]);

  useLayoutEffect(() => {
    if (!tooltip || !tooltipRef.current) {
      return;
    }

    const updatePosition = (): void => {
      const anchorEl = tooltip.anchorEl;
      const tooltipEl = tooltipRef.current;
      if (!anchorEl || !tooltipEl || !anchorEl.isConnected) {
        hideNow();
        return;
      }
      const nextPosition = computeTooltipPosition(anchorEl, tooltipEl, tooltip.preferredPlacement ?? "auto");
      setPosition((current) => (areTooltipPositionsEqual(current, nextPosition) ? current : nextPosition));
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [hideNow, tooltip]);

  useEffect(() => {
    const handlePointerOver = (event: PointerEvent): void => {
      if (event.pointerType === "touch") {
        return;
      }
      if (isWithinTooltip(event.target)) {
        clearHideTimer();
        clearResetTimer();
        return;
      }
      const tooltipTarget = findTooltipTarget(event.target);
      if (!tooltipTarget) {
        return;
      }
      const resolvedTooltip = readTooltipContent(tooltipTarget);
      if (resolvedTooltip == null) {
        return;
      }
      requestOpen({
        anchorEl: tooltipTarget,
        sourceEl: tooltipTarget,
        content: resolvedTooltip.content,
        preferredPlacement: resolvedTooltip.preferredPlacement,
        delayMs: resolvedTooltip.delayMs ?? undefined,
      });
    };

    const handlePointerOut = (event: PointerEvent): void => {
      if (event.pointerType === "touch") {
        return;
      }
      const activeSource = activeSourceRef.current;
      const activeSourceFallback =
        activeSource && event.target instanceof Node && activeSource.contains(event.target)
          ? activeSource
          : null;
      const tooltipTarget = findTooltipTarget(event.target) ?? activeSourceFallback;
      if (!tooltipTarget) {
        return;
      }
      requestClose(tooltipTarget, event.relatedTarget ?? null);
    };

    const handleFocusIn = (event: FocusEvent): void => {
      const tooltipTarget = findTooltipTarget(event.target);
      if (!tooltipTarget) {
        return;
      }
      const resolvedTooltip = readTooltipContent(tooltipTarget);
      if (resolvedTooltip == null) {
        return;
      }
      requestOpen({
        anchorEl: tooltipTarget,
        sourceEl: tooltipTarget,
        content: resolvedTooltip.content,
        preferredPlacement: resolvedTooltip.preferredPlacement,
        delayMs: resolvedTooltip.delayMs ?? undefined,
      });
    };

    const handleFocusOut = (event: FocusEvent): void => {
      const activeSource = activeSourceRef.current;
      const activeSourceFallback =
        activeSource && event.target instanceof Node && activeSource.contains(event.target)
          ? activeSource
          : null;
      const tooltipTarget = findTooltipTarget(event.target) ?? activeSourceFallback;
      if (!tooltipTarget) {
        return;
      }
      requestClose(tooltipTarget, event.relatedTarget ?? null);
    };

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        hideNow();
      }
    };

    document.addEventListener("pointerover", handlePointerOver, true);
    document.addEventListener("pointerout", handlePointerOut, true);
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("focusout", handleFocusOut, true);
    window.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("pointerover", handlePointerOver, true);
      document.removeEventListener("pointerout", handlePointerOut, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("focusout", handleFocusOut, true);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [clearHideTimer, clearResetTimer, hideNow, isWithinTooltip, requestClose, requestOpen]);

  useEffect(() => {
    return () => {
      clearShowTimer();
      clearHideTimer();
      clearResetTimer();
      clearExitTimer();
      restoreSourceAccessibility(activeSourceRef.current);
    };
  }, [clearExitTimer, clearHideTimer, clearResetTimer, clearShowTimer, restoreSourceAccessibility]);

  const contextValue = useMemo<TooltipContextValue>(() => ({
    tooltipId: tooltip?.id ?? null,
    isSourceActive: (sourceEl) => Boolean(sourceEl && activeSourceRef.current === sourceEl && tooltip),
    requestOpen,
    requestClose,
    isWithinTooltip,
  }), [isWithinTooltip, requestClose, requestOpen, tooltip]);

  const tooltipStyle = useMemo<CSSProperties>(() => ({
    top: position.top,
    left: position.left,
  }), [position.left, position.top]);

  return (
    <TooltipContext.Provider value={contextValue}>
      {children}
      {tooltip && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={tooltipRef}
              id={tooltip.id}
              className={`messly-tooltip${tooltip.isVisible ? " is-visible" : ""}`}
              style={tooltipStyle}
              data-placement={position.placement}
              role="tooltip"
              onMouseEnter={() => {
                clearHideTimer();
                clearResetTimer();
              }}
              onMouseLeave={(event) => {
                requestClose(activeSourceRef.current, event.relatedTarget);
              }}
            >
              <div className="messly-tooltip__content">{tooltip.content}</div>
            </div>,
            document.body,
          )
        : null}
    </TooltipContext.Provider>
  );
}

export default function Tooltip({
  text,
  content,
  children,
  disabled = false,
  className,
  position = "auto",
  delay = TOOLTIP_INITIAL_DELAY_MS,
}: TooltipProps) {
  const context = useContext(TooltipContext);
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const resolvedContent = content ?? text;
  const normalizedDelay = Number.isFinite(delay) ? Math.max(0, Math.min(2_000, Math.round(delay))) : TOOLTIP_INITIAL_DELAY_MS;

  if (!context || disabled || resolvedContent == null) {
    return <>{children}</>;
  }

  const isActive = context.isSourceActive(triggerRef.current);

  return (
    <span
      ref={triggerRef}
      className={`messly-tooltip-trigger${className ? ` ${className}` : ""}`}
      aria-describedby={isActive ? context.tooltipId ?? undefined : undefined}
      onMouseOver={() => {
        if (!triggerRef.current) {
          return;
        }
        context.requestOpen({
          anchorEl: triggerRef.current,
          sourceEl: triggerRef.current,
          content: resolvedContent,
          preferredPlacement: position,
          delayMs: normalizedDelay,
        });
      }}
      onMouseOut={(event) => {
        context.requestClose(triggerRef.current, event.relatedTarget ?? null);
      }}
      onFocusCapture={() => {
        if (!triggerRef.current) {
          return;
        }
        context.requestOpen({
          anchorEl: triggerRef.current,
          sourceEl: triggerRef.current,
          content: resolvedContent,
          preferredPlacement: position,
          delayMs: normalizedDelay,
        });
      }}
      onBlurCapture={(event) => {
        context.requestClose(triggerRef.current, event.relatedTarget ?? null);
      }}
      data-messly-tooltip-trigger="true"
    >
      {children}
    </span>
  );
}
