import { type PointerEvent, type RefObject, useLayoutEffect, useRef } from "react";
import { useFrameRequest } from "../properties/use-frame-request";
import {
  CENTRED,
  clampDialogOffset,
  type DialogBox,
  type DialogOffset,
  isDialogOffsetReachable,
  rememberDialogOffset,
  rememberedDialogOffset,
} from "./dialog-drag";

/** Controls inside the title bar, such as the close button, that a press must not drag. */
const CONTROL = "button, a, input, select, textarea, [role='button']";

interface Drag {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly start: DialogOffset;
  readonly bar: DialogBox;
  readonly viewport: { readonly width: number; readonly height: number };
}

export interface DialogDragHandlers {
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
  readonly onLostPointerCapture: (event: PointerEvent<HTMLElement>) => void;
  readonly onDoubleClick: (event: { readonly target: EventTarget }) => void;
}

/** The dialog frame the title bar moves: the modal box around it. */
function frameOf(bar: HTMLElement): HTMLElement {
  return bar.closest<HTMLElement>(".modal") ?? bar.parentElement ?? bar;
}

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(CONTROL) !== null;
}

/**
 * Makes a dialog's title bar drag the dialog. The frame moves by a CSS transform, written at most
 * once per frame and without a React render; the title bar always stays reachable, also after the
 * window or the dialog changes size. With a `positionKey` the dialog reopens where it was left this
 * session. Double-clicking the title bar centres the dialog again.
 */
export function useDialogDrag(
  barRef: RefObject<HTMLElement | null>,
  positionKey: string | undefined,
): DialogDragHandlers {
  const offset = useRef<DialogOffset>(CENTRED);
  const drag = useRef<Drag | undefined>(undefined);
  const frames = useFrameRequest();

  const apply = (next: DialogOffset) => {
    const bar = barRef.current;
    offset.current = next;
    if (bar === null) return;
    frameOf(bar).style.transform =
      next.x === 0 && next.y === 0 ? "" : `translate(${next.x}px, ${next.y}px)`;
  };

  /** The title bar's box with the dialog centred: the frame's width, from its top to the bar's bottom. */
  const centredBar = (): DialogBox | undefined => {
    const bar = barRef.current;
    if (bar === null) return undefined;
    const frame = frameOf(bar).getBoundingClientRect();
    const header = bar.getBoundingClientRect();
    const { x, y } = offset.current;
    return {
      left: frame.left - x,
      top: frame.top - y,
      right: frame.right - x,
      bottom: Math.max(frame.top, header.bottom) - y,
    };
  };

  const remember = (next: DialogOffset) => {
    if (positionKey !== undefined) rememberDialogOffset(positionKey, next);
  };

  // Keep the latest closures for the listeners registered once per dialog.
  const latest = useRef({ apply, centredBar, remember });
  latest.current = { apply, centredBar, remember };

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (bar === null) return undefined;
    const stored = positionKey === undefined ? undefined : rememberedDialogOffset(positionKey);
    if (stored !== undefined) {
      const box = latest.current.centredBar();
      // A place that is no longer reachable, after the window shrank, falls back to the centre.
      if (box !== undefined && isDialogOffsetReachable(stored, box, viewport())) {
        latest.current.apply(stored);
      } else {
        latest.current.remember(CENTRED);
      }
    }
    const reclamp = () => {
      if (drag.current !== undefined) return;
      const box = latest.current.centredBar();
      if (box === undefined) return;
      const next = clampDialogOffset(offset.current, box, viewport());
      if (next.x === offset.current.x && next.y === offset.current.y) return;
      latest.current.apply(next);
      latest.current.remember(next);
    };
    window.addEventListener("resize", reclamp);
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(reclamp);
    observer?.observe(frameOf(bar));
    return () => {
      window.removeEventListener("resize", reclamp);
      observer?.disconnect();
    };
  }, [barRef, positionKey]);

  const end = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (current === undefined || current.pointerId !== event.pointerId) return;
    frames.flush();
    drag.current = undefined;
    delete event.currentTarget.dataset.dragging;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    remember(offset.current);
  };

  return {
    onPointerDown: (event) => {
      if (event.button !== 0 || drag.current !== undefined || isControl(event.target)) return;
      const box = centredBar();
      if (box === undefined) return;
      // No text selection and no focus change: the press only grabs the dialog.
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.currentTarget.dataset.dragging = "";
      drag.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        start: offset.current,
        bar: box,
        viewport: viewport(),
      };
    },
    onPointerMove: (event) => {
      const current = drag.current;
      if (current === undefined || current.pointerId !== event.pointerId) return;
      const next = clampDialogOffset(
        {
          x: current.start.x + event.clientX - current.startX,
          y: current.start.y + event.clientY - current.startY,
        },
        current.bar,
        current.viewport,
      );
      frames.request(() => apply(next));
    },
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
    onDoubleClick: (event) => {
      if (isControl(event.target)) return;
      apply(CENTRED);
      remember(CENTRED);
    },
  };
}
