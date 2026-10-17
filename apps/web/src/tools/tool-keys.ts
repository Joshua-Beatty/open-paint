import { escapeAction, isCommitKey } from "@openpaint/tools";
import { isEditingTarget } from "../commands/shortcuts";
import { nudgeStep } from "./nudge-burst";
import type { ToolController } from "./tool-controller";

/** The arrow keys and the offset each one nudges a selected target by (TL-MOVE-01). */
const ARROW_STEPS: Readonly<Record<string, { readonly dx: number; readonly dy: number }>> = {
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
};

/** How far an arrow key scrolls the view when the active tool does not use it, in CSS pixels (TL-HOTKEY-03). */
export const ARROW_SCROLL_CSS_PIXELS = 100;

export interface ToolKeyHost {
  readonly controller: ToolController;
  /** Tool hotkeys and Enter or Esc work only while the canvas has focus (TL-HOTKEY-01). */
  readonly canvasHasFocus: () => boolean;
  /** Whether Deselect has a selection to clear (TL-HOTKEY-03). */
  readonly canDeselect: () => boolean;
  /** Runs Deselect. Returns whether it ran. */
  readonly deselect: () => boolean;
  /**
   * Scrolls the view by CSS pixels in the arrow's direction (TL-HOTKEY-03), for an arrow key the
   * active tool does not use. Ctrl+Arrow is left to the engine's pan.
   */
  readonly scrollView?: (dx: number, dy: number) => void;
}

/**
 * Routes tool hotkeys and the shared Enter and Esc rules (TL-FRAME-01, TL-HOTKEY-01, TL-HOTKEY-03).
 * Keys in a text field are left alone (WEB-KEY-05), and a key that another listener has already
 * handled is skipped. Returns the function that removes the listener.
 */
export function listenForToolKeys(target: Window, host: ToolKeyHost): () => void {
  // A Ctrl press that no other key or pointer press follows is a tap (TL-LINE-01).
  let ctrlTap = false;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Control") {
      ctrlTap = !event.repeat;
      return;
    }
    ctrlTap = false;
    // Alt presses during a drag are consumed, so they do not open menu access keys (TL-SEL-01).
    if (event.key === "Alt" && host.controller.pointerHeld) {
      event.preventDefault();
      return;
    }
    if (event.defaultPrevented || event.isComposing || isEditingTarget(event.target)) return;
    if (!host.canvasHasFocus()) return;
    if (isCommitKey(event)) {
      if (runCommitKey(host)) event.preventDefault();
      return;
    }
    const arrow = ARROW_STEPS[event.code];
    if (arrow !== undefined && !event.altKey && !event.metaKey) {
      const runtime = host.controller.runtime();
      if (runtime?.nudge?.(arrow.dx, arrow.dy, nudgeStep(event)) === true) {
        event.preventDefault();
      } else if (!event.ctrlKey && host.scrollView !== undefined) {
        host.scrollView(arrow.dx * ARROW_SCROLL_CSS_PIXELS, arrow.dy * ARROW_SCROLL_CSS_PIXELS);
        event.preventDefault();
      }
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const letter = /^Key([A-Z])$/.exec(event.code)?.[1];
    if (letter === undefined) return;
    if (host.controller.handleHotkey(letter, { reverse: event.shiftKey })) event.preventDefault();
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key !== "Control" || !ctrlTap) return;
    ctrlTap = false;
    if (isEditingTarget(event.target) || !host.canvasHasFocus()) return;
    host.controller.runtime()?.tapCtrl?.();
  };
  const onPointerDown = () => {
    ctrlTap = false;
  };
  target.addEventListener("keydown", onKeyDown);
  target.addEventListener("keyup", onKeyUp);
  target.addEventListener("pointerdown", onPointerDown);
  return () => {
    target.removeEventListener("keydown", onKeyDown);
    target.removeEventListener("keyup", onKeyUp);
    target.removeEventListener("pointerdown", onPointerDown);
  };
}

/** Runs the Enter or Esc action. Returns whether the key did something. */
function runCommitKey(host: ToolKeyHost): boolean {
  const runtime = host.controller.runtime();
  const action = escapeAction({
    drawing: host.controller.pointerHeld,
    pending: runtime?.hasPending?.() === true,
    canDeselect: host.canDeselect(),
  });
  switch (action) {
    case "cancelDrawing":
      runtime?.cancel?.();
      return true;
    case "commit":
      runtime?.commit?.();
      return true;
    case "deselect":
      return host.deselect();
    case "none":
      return false;
  }
}
