import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * The compact layout for phones, small tablets and small windows: below this width or height the
 * desktop shell (UI-WIN-02, 1024 x 700) does not fit. Every desktop size keeps the desktop layout.
 */
export const COMPACT_BELOW_WIDTH = 1024;
export const COMPACT_BELOW_HEIGHT = 600;
/** Below this height the compact header is one row: the tool options share the top bar. */
export const SHORT_BELOW_HEIGHT = 500;
/** From this width the compact panel sheet is a drawer at the right instead of at the bottom. */
export const SIDE_SHEET_FROM_WIDTH = 600;

export interface CompactLayout {
  /** Whether the compact layout is used at all. */
  readonly compact: boolean;
  /** One header row (phone landscape). */
  readonly short: boolean;
  /** The panel sheet is a right-hand drawer rather than a bottom sheet. */
  readonly sideSheet: boolean;
}

export const DESKTOP_LAYOUT: CompactLayout = { compact: false, short: false, sideSheet: false };

/** The layout for a viewport size in CSS px. */
export function compactLayoutFor(width: number, height: number): CompactLayout {
  const compact = width < COMPACT_BELOW_WIDTH || height < COMPACT_BELOW_HEIGHT;
  if (!compact) return DESKTOP_LAYOUT;
  return {
    compact,
    short: height < SHORT_BELOW_HEIGHT,
    sideSheet: width >= SIDE_SHEET_FROM_WIDTH,
  };
}

function same(a: CompactLayout, b: CompactLayout): boolean {
  return a.compact === b.compact && a.short === b.short && a.sideSheet === b.sideSheet;
}

/**
 * The layout for the window's size, updated on resize and rotation. While compact, the root
 * element carries `data-layout="compact"`, so dialogs and popovers that render outside the shell
 * can style themselves for it, and `--app-visual-height` holds the visual viewport's height, which
 * the on-screen keyboard shrinks in Safari.
 */
export function useCompactLayout(): CompactLayout {
  const [layout, setLayout] = useState(() => compactLayoutFor(innerWidth, innerHeight));
  useEffect(() => {
    const update = () =>
      setLayout((previous) => {
        const next = compactLayoutFor(innerWidth, innerHeight);
        return same(previous, next) ? previous : next;
      });
    addEventListener("resize", update);
    return () => removeEventListener("resize", update);
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    if (!layout.compact) {
      delete root.dataset.layout;
      return undefined;
    }
    root.dataset.layout = "compact";
    const visual = window.visualViewport;
    const track = () => {
      const height = visual?.height ?? innerHeight;
      root.style.setProperty("--app-visual-height", `${Math.round(height)}px`);
    };
    track();
    visual?.addEventListener("resize", track);
    return () => {
      visual?.removeEventListener("resize", track);
      delete root.dataset.layout;
      root.style.removeProperty("--app-visual-height");
    };
  }, [layout.compact]);
  return layout;
}

/** Remembers whether this session has seen touch input, and tells listeners once it does. */
class TouchPresence {
  #seen = false;
  readonly #listeners = new Set<() => void>();
  #stop: (() => void) | undefined;

  get seen(): boolean {
    return this.#seen;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    this.#start();
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #start(): void {
    if (this.#seen || this.#stop !== undefined || typeof window === "undefined") return;
    const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    if (coarse) {
      this.#seen = true;
      return;
    }
    const onPointer = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      this.#seen = true;
      this.#stop?.();
      for (const listener of this.#listeners) listener();
    };
    const options = { capture: true, passive: true } as const;
    addEventListener("pointerdown", onPointer, options);
    this.#stop = () => removeEventListener("pointerdown", onPointer, options);
  }
}

const TOUCH = new TouchPresence();

/**
 * Whether touch controls should show: the primary pointer is coarse (a phone or tablet), or a
 * touch has reached the page in this session (a touch-screen laptop).
 */
export function useTouchControls(): boolean {
  return useSyncExternalStore(TOUCH.subscribe, () => TOUCH.seen);
}
