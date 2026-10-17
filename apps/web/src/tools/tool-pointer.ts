import type { ToolRuntime, ToolViewState } from "@openpaint/extension-api";
import {
  type ImageMapper,
  isPenEraser,
  type PointerPhase,
  type PointerSource,
  toolSamples,
} from "@openpaint/tools";
import { measured } from "../perf/user-timing";
import type { ToolController } from "./tool-controller";

/** The Eraser's registry id, which a pen's eraser end switches to (WEB-PTR-02). */
const ERASER_TOOL_ID = "eraser";

/** Receives the canvas pointer events for the active tool (TL-FRAME-07, WEB-PTR-01 to 04). */
export interface ToolPointerSink {
  pointer(phase: PointerPhase, source: PointerSource, toImage: ImageMapper): void;
  /** The canvas cursor the active tool shows for a view state, or undefined for the default. */
  cursor(view: ToolViewState): string | undefined;
  /** Whether a left-button drag pans the view instead of reaching the active tool (TL-PAN-01). */
  panOnDrag(): boolean;
}

/**
 * Feeds the canvas pointer to the active tool. A down marks a drawing in progress, which blocks
 * tool switching (TL-HOTKEY-01). Each event becomes its coalesced and predicted samples in canvas
 * pixels (WEB-PTR-01) and goes to the runtime, if the tool has one. A pen's eraser end sends its
 * whole contact to the Eraser, even when another tool is active (WEB-PTR-02).
 */
export function createToolPointerSink(
  controller: ToolController,
  /** A promise while an Undo or Redo runs; input waits for it as for a settling tool. */
  historyRunning: () => Promise<void> | undefined = () => undefined,
): ToolPointerSink {
  let contact: ToolRuntime | undefined;
  let contactOpened = false;
  /** Input that came while a tool was settling, in order. */
  let held: [PointerPhase, PointerSource, ImageMapper][] | undefined;
  const sink: ToolPointerSink = {
    cursor(view) {
      return controller.runtime()?.cursor?.(view);
    },
    panOnDrag() {
      return controller.runtime()?.panOnDrag === true;
    },
    pointer(phase, source, toImage) {
      // While a tool still computes a result it will record, or an Undo or Redo runs, input waits,
      // so nothing is drawn over pixels that are not in the history yet and no edit meets a busy
      // history. It runs in order once they settle.
      if (held !== undefined) {
        held.push([phase, source, toImage]);
        return;
      }
      const settling = controller.settling() ?? historyRunning();
      if (settling !== undefined) {
        const queue: [PointerPhase, PointerSource, ImageMapper][] = [[phase, source, toImage]];
        held = queue;
        const replay = () => {
          held = undefined;
          for (const [p, s, m] of queue) sink.pointer(p, s, m);
        };
        settling.then(replay, replay);
        return;
      }
      if (phase === "down") {
        controller.setPointerHeld(true);
        if (isPenEraser(source) && controller.active.id !== ERASER_TOOL_ID) {
          contact = controller.openContactRuntime(ERASER_TOOL_ID);
          contactOpened = true;
        }
      } else if (phase === "up" || phase === "cancel") controller.setPointerHeld(false);
      const runtime = contact ?? controller.runtime();
      if (runtime !== undefined) {
        measured(`tool pointer ${phase}`, () => {
          for (const sample of toolSamples(phase, source, toImage)) runtime.pointer(sample);
        });
      }
      if (phase === "up" || phase === "cancel") {
        if (contactOpened) contact?.deactivate();
        contact = undefined;
        contactOpened = false;
      }
    },
  };
  return sink;
}
