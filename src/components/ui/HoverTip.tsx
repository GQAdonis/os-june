import {
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

const DEFAULT_TIP_WIDTH = 300;
const TIP_GAP = 6;
const VIEWPORT_MARGIN = 8;
// Flip above the anchor when less than this remains below — enough for the
// longest privacy explainer at the default cap without clipping.
const MIN_SPACE_BELOW = 200;
// Hover-intent delay before the card opens — a pointer sweeping across the
// anchor should not flash it. Matches the model popover's flyout debounce;
// keyboard focus stays immediate.
const HOVER_INTENT_MS = 150;
// Exit fade duration. The unmount timer must outlast the CSS transition so a
// missed transitionend (interrupted paint) still tears the tip down.
const EXIT_MS = 140;

type TipCoords = {
  side: "top" | "bottom";
  top: number;
  left: number;
};

// The anchor's midpoint x and its below/top gap coordinates, captured at open
// time; the final left is derived once the tip's own width is measured.
type TipAnchor = {
  side: "top" | "bottom";
  top: number;
  centerX: number;
};

type HoverTipProps = HTMLAttributes<HTMLSpanElement> & {
  /** Callout body shown on hover/focus of the wrapped content. */
  tip: ReactNode;
  /** Max card width in px. The tip sizes to its content and only wraps past
   * this cap. Defaults to the wide explainer cap; pass a small value for
   * compact shortcut-style tips. */
  width?: number;
  /** Tightens padding and centers content for a small one-line tip. */
  compact?: boolean;
  /** Hover-intent delay (ms) before the tip opens. Defaults to the shared
   * hover-intent debounce; pass a larger value for a more deliberate tooltip. */
  delay?: number;
  children: ReactNode;
};

/**
 * Hover/focus callout card — the rich replacement for a native `title`
 * tooltip (styled, multi-line, hover-intent debounced). The card renders into
 * a body portal at a fixed position, so it never clips inside scroll
 * containers or dialog cards; scrolling anywhere dismisses it rather than
 * letting it drift off its anchor.
 *
 * The tip sizes to its content: it renders once hidden to measure its actual
 * width, then clamps its centered position to the viewport and reveals — so
 * the enter animation runs from the revealed state and never plays offscreen.
 */
export function HoverTip({
  tip,
  width = DEFAULT_TIP_WIDTH,
  compact = false,
  delay = HOVER_INTENT_MS,
  children,
  ...spanProps
}: HoverTipProps) {
  const {
    "aria-describedby": ariaDescribedBy,
    onBlur,
    onFocus,
    onMouseEnter,
    onMouseLeave,
    ...restSpanProps
  } = spanProps;
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLSpanElement | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const tooltipId = useId();
  // The anchor geometry captured at open; drives the measure pass.
  const [anchor, setAnchor] = useState<TipAnchor>();
  // The final clamped coordinates, set after measuring the rendered tip.
  const [coords, setCoords] = useState<TipCoords>();
  // "open" once revealed (enter animation runs), "closing" during the exit
  // fade. Absent while measuring or unmounted.
  const [phase, setPhase] = useState<"open" | "closing">();
  const mounted = anchor !== undefined;
  const describedBy = [ariaDescribedBy, mounted ? tooltipId : null].filter(Boolean).join(" ");

  const cancelHoverIntent = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const unmount = useCallback(() => {
    cancelClose();
    setAnchor(undefined);
    setCoords(undefined);
    setPhase(undefined);
  }, [cancelClose]);

  function show() {
    cancelClose();
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const side = window.innerHeight - rect.bottom < MIN_SPACE_BELOW ? "top" : "bottom";
    setAnchor({
      side,
      centerX: rect.left + rect.width / 2,
      top: side === "bottom" ? rect.bottom + TIP_GAP : rect.top - TIP_GAP,
    });
    // A re-entry mid-fade reuses the mounted node: re-assert the open phase so
    // the render before the measure effect lands shows "open", not a stale
    // mid-fade "closing" frame.
    setPhase("open");
  }

  function showAfterHoverIntent() {
    cancelHoverIntent();
    hoverTimerRef.current = window.setTimeout(show, delay);
  }

  function hide() {
    cancelHoverIntent();
    if (!mounted) return;
    setPhase("closing");
    cancelClose();
    closeTimerRef.current = window.setTimeout(unmount, EXIT_MS);
  }

  // Measure the rendered tip and clamp its centered position to the viewport,
  // all before paint, so the reveal never jumps. jsdom reports a zero-width
  // rect (no layout); that still resolves to a positioned, visible tip.
  // `tip` is a deliberate extra dependency: a content swap while open (e.g.
  // "Copy message" → "Copied") resizes the chip, and the re-measure recenters
  // it without re-triggering the enter animation.
  // biome-ignore lint/correctness/useExhaustiveDependencies(tip): re-measure on content change
  useLayoutEffect(() => {
    if (!anchor) return;
    const tipWidth = tipRef.current?.getBoundingClientRect().width ?? 0;
    const left = Math.min(
      Math.max(anchor.centerX - tipWidth / 2, VIEWPORT_MARGIN),
      Math.max(window.innerWidth - tipWidth - VIEWPORT_MARGIN, VIEWPORT_MARGIN),
    );
    setCoords({ side: anchor.side, top: anchor.top, left });
  }, [anchor, tip]);

  useEffect(
    () => () => {
      cancelHoverIntent();
      cancelClose();
    },
    [cancelHoverIntent, cancelClose],
  );

  useEffect(() => {
    if (!mounted) return;
    // Scroll/resize would drift the tip off its anchor; cut it immediately
    // rather than fading in place.
    window.addEventListener("scroll", unmount, true);
    window.addEventListener("resize", unmount);
    return () => {
      window.removeEventListener("scroll", unmount, true);
      window.removeEventListener("resize", unmount);
    };
  }, [mounted, unmount]);

  return (
    <span
      ref={anchorRef}
      {...restSpanProps}
      aria-describedby={describedBy}
      onMouseEnter={(event) => {
        onMouseEnter?.(event);
        showAfterHoverIntent();
      }}
      onMouseLeave={(event) => {
        onMouseLeave?.(event);
        hide();
      }}
      onFocus={(event) => {
        onFocus?.(event);
        show();
      }}
      onBlur={(event) => {
        onBlur?.(event);
        hide();
      }}
    >
      {children}
      {mounted
        ? createPortal(
            <span
              ref={tipRef}
              id={tooltipId}
              className={compact ? "hover-tip hover-tip-compact" : "hover-tip"}
              role="tooltip"
              data-side={coords?.side ?? anchor.side}
              // Hidden until measured: the enter animation runs only once the
              // final position is revealed, never while offscreen.
              data-state={coords ? phase : "measuring"}
              onTransitionEnd={(event) => {
                if (event.propertyName === "opacity" && phase === "closing") unmount();
              }}
              style={{
                top: coords?.top ?? anchor.top,
                left: coords?.left ?? 0,
                maxWidth: width,
              }}
            >
              {tip}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
