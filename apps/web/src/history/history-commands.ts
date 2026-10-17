import type { Document } from "@openpaint/document";
import type { BuiltInCommandId } from "../commands/catalog";
import type { ShortcutController } from "../commands/shortcuts";
import { settleColorEdits } from "../tools/color-edits";
import { engineStrokesSettled } from "../tools/engine-stroke";
import { settleNudges } from "../tools/nudge-burst";

/** The Undo or Redo still running, oldest first in the chain; undefined once they have landed. */
let running: Promise<void> | undefined;

/**
 * A promise while an Undo or Redo runs. Canvas input waits for it, so a tool never edits while the
 * history is busy (which would fail the edit) or adjusts a pending result the undo is taking back.
 */
export function historyRunning(): Promise<void> | undefined {
  return running;
}

/** Runs `step` after any Undo or Redo before it, and tracks it until it lands. */
function track(step: () => Promise<unknown> | undefined): void {
  const previous = running ?? Promise.resolve();
  const next: Promise<void> = previous
    .then(() => engineStrokesSettled())
    .then(() => step())
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      if (running === next) running = undefined;
    });
  running = next;
}

/**
 * Connects Undo and Redo (Ctrl+Z, Ctrl+Y, the Edit menu and the History panel buttons) to the open
 * image. Both run through the controller, so their enable rules match everywhere. Returns the
 * function that detaches them.
 */
export function registerHistoryCommands(
  controller: ShortcutController<BuiltInCommandId>,
  document: () => Document | undefined,
): () => void {
  const detach = [
    controller.register("edit.undo", {
      // A stroke still being read back from the engine, or a nudge or color change of a pending
      // tool result still merging, lands first, so Undo takes it back.
      run: () => {
        settleNudges();
        settleColorEdits();
        track(() => document()?.history.undo());
      },
      enabled: () => document()?.history.canUndo === true,
    }),
    controller.register("edit.redo", {
      run: () => {
        settleNudges();
        settleColorEdits();
        track(() => document()?.history.redo());
      },
      enabled: () => document()?.history.canRedo === true,
    }),
  ];
  return () => {
    for (const release of detach) release();
  };
}
