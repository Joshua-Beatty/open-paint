import type {
  Document,
  HistoryCommand,
  Layer,
  Selection,
  Surface,
  ToolStep,
} from "@openpaint/document";
import type { ToolRuntime } from "@openpaint/extension-api";
import type { SettingsStore } from "@openpaint/storage";
import { restoreSettings, type SettingSnapshot, snapshotSettings } from "./pending-steps";

/** The kind of a tool's history item (`ToolStep.kind`). */
export type StepKind = ToolStep["kind"];

/** The document as it was before a result's first history item (`Document.stateBefore`). */
export interface StateBefore {
  readonly tiles: ReadonlyMap<number, Surface | null>;
  readonly selection: Selection;
}

/** Where a tool takes up a pending state from history: the result's document, layer and items. */
export interface StepContext {
  readonly document: Document;
  /** The layer the result is drawn on, which is the active layer. */
  readonly layer: Layer;
  /** The result the state belongs to (`ToolStep.session`). */
  readonly session: object;
  /**
   * The document before the result's first item, read from the items' own undo data. Only tiles
   * the items changed are given; the layer has the others as they were.
   */
  readonly before: () => Promise<StateBefore>;
}

/**
 * A tool whose pending results live in their history items (TL-FRAME-01): each item it records
 * holds its state on either side (`ToolStep`), and undo or redo hands the tool the side it lands on.
 */
export interface SteppedRuntime extends ToolRuntime {
  /** The result the tool has pending, as its items name it, or undefined when it is Idle. */
  pendingSession(): object | undefined;
  /**
   * Takes up `state` as the pending result, or goes Idle with undefined, recording nothing. The
   * document already shows the state. `context` is undefined when the tool only has to let go of a
   * result that another history item has replaced.
   */
  restoreStep(state: unknown, context: StepContext | undefined): void | Promise<void>;
}

export function isStepped(runtime: ToolRuntime | undefined): runtime is SteppedRuntime {
  return runtime !== undefined && "restoreStep" in runtime && "pendingSession" in runtime;
}

/** What the history needs of the tool controller. */
export interface ToolSwitcher {
  readonly active: { readonly id: string };
  readonly pointerHeld: boolean;
  /** Makes a tool active; the tool switched away from must have nothing pending. */
  activate(id: string): boolean;
  /** The active tool's runtime, created if needed. */
  runtime(): ToolRuntime | undefined;
  /** The active tool's runtime if it exists, without creating one. */
  current(): ToolRuntime | undefined;
}

/** The newest applied items of one result, oldest first. */
export function sessionItems(document: Document, session: object): HistoryCommand[] {
  const applied = document.history.appliedCommands;
  let start = applied.length;
  while (start > 0 && document.history.stepOf(applied[start - 1])?.session === session) start--;
  return applied.slice(start);
}

/**
 * Lets the tools follow `document`'s history (TL-FRAME-01, owner request: history is reversible
 * from the start). Before a tool's item is undone or redone, a gesture in progress is cancelled and
 * the item's tool and layer become active; afterwards the tool takes up the state on the side the
 * history landed on. Other items leave a pending result as it is. A new item that is not the
 * pending result's own makes the tool let go of it. Returns the function that stops following.
 */
export function bindToolHistory(
  document: Document,
  tools: ToolSwitcher,
  report: (cause: unknown) => void = () => {},
): () => void {
  let stepping = false;

  /** Makes `step`'s tool and layer active. A result of another session is dropped first. */
  const enter = (step: ToolStep): void => {
    const current = tools.current();
    if (isStepped(current)) {
      const pending = current.pendingSession();
      if (pending !== undefined && (pending !== step.session || tools.active.id !== step.tool)) {
        void current.restoreStep(undefined, undefined);
      }
    }
    if (tools.active.id !== step.tool) tools.activate(step.tool);
    const layer = document.layers[step.layer];
    if (layer !== undefined && document.activeLayer !== layer) document.setActiveLayer(layer);
  };

  const restore = async (step: ToolStep, state: unknown): Promise<void> => {
    if (tools.active.id !== step.tool) return;
    const runtime = tools.runtime();
    const layer = document.layers[step.layer];
    if (!isStepped(runtime) || layer === undefined) return;
    await runtime.restoreStep(state, {
      document,
      layer,
      session: step.session,
      before: () => document.stateBefore(layer, sessionItems(document, step.session)),
    });
  };

  return document.history.setStepper({
    before: (_command, step) => {
      stepping = true;
      try {
        if (tools.pointerHeld) tools.current()?.cancel?.();
        if (step !== undefined) enter(step);
      } catch (cause) {
        report(cause);
      }
    },
    after: async (_command, step, direction) => {
      try {
        if (step !== undefined) {
          await restore(step, direction === "undo" ? step.before : step.after);
          return;
        }
        // Another item: a pending result stays as it is. With none, the result an earlier item left
        // pending, if any, is taken up again (it was let go of when this item was recorded).
        const current = tools.current();
        if (isStepped(current) && current.pendingSession() !== undefined) return;
        const top = document.history.stepOf(document.history.appliedCommands.at(-1));
        if (top?.after === undefined) return;
        enter(top);
        await restore(top, top.after);
      } catch (cause) {
        report(cause);
      } finally {
        stepping = false;
      }
    },
    recorded: (_command, step) => {
      if (stepping) return;
      const current = tools.current();
      if (!isStepped(current)) return;
      const pending = current.pendingSession();
      if (pending !== undefined && step?.session !== pending) {
        void current.restoreStep(undefined, undefined);
      }
    },
  });
}

/** A switcher with one tool, for a runtime used on its own (tests). */
export function soloSwitcher(id: string, runtime: ToolRuntime): ToolSwitcher {
  return {
    active: { id },
    pointerHeld: false,
    activate: (other) => other === id,
    runtime: () => runtime,
    current: () => runtime,
  };
}

/** Records the items `action` adds as the tool step `step`. Returns what `action` returns. */
export function recordStep<T>(document: Document, step: ToolStep, action: () => T): T {
  return document.history.withStep(step, action);
}

/** The position of `layer` in its document, as a tool step records it. */
export function layerIndex(document: Document, layer: Layer): number {
  return document.layers.indexOf(layer);
}

/**
 * The option values a pending result shows on the options bar (TL-FRAME-01). Taking up a result
 * from Idle first saves the user's own values, which come back when the result is left without
 * being edited (undo past its first step, or redo of its Finish); an edit or a Finish drops them.
 */
export class PendingOptions {
  readonly #paths: readonly string[];
  readonly #quietly: (action: () => void) => void;
  #saved: SettingSnapshot | undefined;

  /** `quietly` runs a write of the settings so the tool does not take it as a user's change. */
  constructor(paths: readonly string[], quietly: (action: () => void) => void) {
    this.#paths = paths;
    this.#quietly = quietly;
  }

  get paths(): readonly string[] {
    return this.#paths;
  }

  /** The values to keep with a step. */
  snapshot(settings: Pick<SettingsStore, "get"> | null): SettingSnapshot {
    return settings === null ? {} : snapshotSettings(settings, this.#paths);
  }

  /** Shows a step's values. `fromIdle` saves the user's values first, once. */
  enter(
    settings: Pick<SettingsStore, "get" | "set"> | null,
    values: SettingSnapshot,
    fromIdle: boolean,
  ): void {
    if (settings === null) return;
    if (fromIdle && this.#saved === undefined)
      this.#saved = snapshotSettings(settings, this.#paths);
    this.#quietly(() => restoreSettings(settings, values));
  }

  /** The result was left unedited: the user's values come back. */
  leave(settings: Pick<SettingsStore, "get" | "set"> | null): void {
    const saved = this.#saved;
    this.#saved = undefined;
    if (settings === null || saved === undefined) return;
    this.#quietly(() => restoreSettings(settings, saved));
  }

  /** The user changed the result: the toolbar keeps its values from now on. */
  edited(): void {
    this.#saved = undefined;
  }
}
