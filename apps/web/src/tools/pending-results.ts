import type { Document, HistoryCommand } from "@openpaint/document";
import type { PaintHost } from "./paint-tools";

/** The state a pending result had after one of its history steps (TL-FRAME-01). */
export interface PendingStep {
  /** Whether Finish recorded the step. A finished result is no longer pending. */
  readonly finished: boolean;
}

/**
 * How many pending results stay editable through undo, newest first. An older one's steps undo
 * as plain pixels, so the layer copies a result keeps for its edits don't pile up per result.
 */
export const PENDING_RESULTS_KEPT = 4;

interface Entry {
  readonly results: PendingResults<object, PendingStep>;
  readonly owner: object;
  readonly step: PendingStep;
}

const entries = new WeakMap<HistoryCommand, Entry>();
/** The results with steps in `entries`, oldest first, and the items each one recorded. */
const kept: { readonly owner: object; readonly commands: HistoryCommand[] }[] = [];

/**
 * The steps of one tool's pending results, stored with the history items that recorded them, so
 * an undo or redo that lands on one gives the tool that result back, editable as it was then (owner
 * request: undoing Finish returns to editing). The history keeps only pixels; this keeps the rest.
 * Re-entering a result records nothing.
 */
export class PendingResults<O extends object, S extends PendingStep> {
  /** The tool that edits the results, as the tool registry names it. */
  readonly tool: string;
  readonly #usable: (owner: O) => boolean;

  /**
   * `usable` tells whether a result can still be edited where it was drawn: its layer is still in
   * the image and active. A result that can't be edits as plain pixels.
   */
  constructor(tool: string, usable: (owner: O) => boolean) {
    this.tool = tool;
    this.#usable = usable;
  }

  /** Stores `step` as the state of `owner` after `command`, the item it just recorded. */
  remember(command: HistoryCommand, owner: O, step: S): void {
    entries.set(command, { results: this as never, owner, step });
    let index = kept.findIndex((result) => result.owner === owner);
    if (index < 0) {
      kept.push({ owner, commands: [] });
      index = kept.length - 1;
    } else if (index !== kept.length - 1) {
      kept.push(...kept.splice(index, 1));
      index = kept.length - 1;
    }
    kept[index]?.commands.push(command);
    while (kept.length > PENDING_RESULTS_KEPT) {
      for (const dropped of kept.shift()?.commands ?? []) entries.delete(dropped);
    }
  }

  /**
   * The result and its state after the document's latest item, when that item is one of ours.
   * `current`, the result the tool holds, needn't be usable: it is finished where it was drawn.
   */
  at(document: Document, current?: O): { readonly owner: O; readonly step: S } | undefined {
    const command = document.history.appliedCommands.at(-1);
    const entry = command === undefined ? undefined : entries.get(command);
    if (entry?.results !== (this as never)) return undefined;
    const owner = entry.owner as O;
    if (owner !== current && !this.#usable(owner)) return undefined;
    return { owner, step: entry.step as S };
  }

  /** The tool of a result still pending after the latest item, if that item is one of ours. */
  pendingAt(document: Document): string | undefined {
    const found = this.at(document);
    return found === undefined || found.step.finished ? undefined : this.tool;
  }
}

/** The tool of the result still pending after the document's latest item, if any tool has one. */
export function pendingToolAt(document: Document): string | undefined {
  const command = document.history.appliedCommands.at(-1);
  const entry = command === undefined ? undefined : entries.get(command);
  return entry?.results.pendingAt(document);
}

/**
 * Calls `changed` once after each change of the open image that may have moved its history (an
 * undo, a redo or an edit), after the change has finished, and when another image becomes active.
 * A tool asks then whether one of its results became pending again.
 */
export class HistoryFollower {
  readonly #host: Pick<PaintHost, "document" | "onDocumentSwitch">;
  readonly #changed: () => void;
  #stopDocument: (() => void) | undefined;
  #stopSwitch: (() => void) | undefined;
  #queued = false;
  #running = false;

  constructor(host: Pick<PaintHost, "document" | "onDocumentSwitch">, changed: () => void) {
    this.#host = host;
    this.#changed = changed;
  }

  /** Starts following, and calls `changed` at once. */
  start(): void {
    this.#running = true;
    this.#stopSwitch = this.#host.onDocumentSwitch?.(() => this.#watch());
    this.#watch();
  }

  stop(): void {
    this.#running = false;
    this.#stopSwitch?.();
    this.#stopDocument?.();
    this.#stopSwitch = undefined;
    this.#stopDocument = undefined;
  }

  #watch(): void {
    this.#stopDocument?.();
    this.#stopDocument = this.#host.document()?.subscribe((change) => {
      if (change !== "state" || this.#queued) return;
      this.#queued = true;
      queueMicrotask(() => {
        this.#queued = false;
        if (this.#running) this.#changed();
      });
    });
    this.#changed();
  }
}

/** What `followPendingResults` needs of the tool controller. */
export interface PendingToolSwitch {
  readonly active: { readonly id: string };
  /** A pointer is held or the active tool has a result of its own pending. */
  readonly editing: boolean;
  activate(id: string): boolean;
}

/**
 * Makes the tool of a result that undo or redo made pending again active, so its handles can be
 * used (owner request). The switch waits until the change has finished, and it doesn't happen
 * while the active tool has a result of its own, which a switch would finish and record. Returns
 * the function that stops following.
 */
export function followPendingResults(document: Document, tools: PendingToolSwitch): () => void {
  let queued = false;
  let stopped = false;
  const stop = document.subscribe((change) => {
    if (change !== "state" || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (stopped) return;
      const tool = pendingToolAt(document);
      if (tool === undefined || tool === tools.active.id || tools.editing) return;
      tools.activate(tool);
    });
  });
  return () => {
    stopped = true;
    stop();
  };
}
