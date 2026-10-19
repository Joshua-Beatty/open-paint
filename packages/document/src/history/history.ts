/** Thrown when a change is attempted while an undo or redo is still running. */
export const BUSY_MESSAGE = "History is busy with an undo or redo.";

/** Thrown when a change is attempted while a background job is reading the document. */
export const HELD_MESSAGE = "A background job is using the document.";

/** One undoable step (DOC-HIS-01). Commands own whatever they spilled and free it in `release`. */
export interface HistoryCommand {
  /** The name shown in the History panel (DOC-HIS-03). */
  readonly name: string;
  /** False for the non-undoable base item (DOC-HIS-01). Defaults to undoable. */
  readonly undoable?: boolean;
  /** The items of a compound entry, in the order they were recorded (DOC-HIS-01). */
  readonly parts?: readonly HistoryCommand[];
  undo(): Promise<void>;
  redo(): Promise<void>;
  /** Frees spilled data. Called when the command leaves history for good. */
  release(): void;
}

/** A non-undoable placeholder item (DOC-HIS-01 "Null" items). Undo never passes it. */
export function placeholderCommand(name: string): HistoryCommand {
  return {
    name,
    undoable: false,
    undo: async () => {},
    redo: async () => {},
    release: () => {},
  };
}

/**
 * One compound item (DOC-HIS-01): undo steps back over `parts` in reverse order and redo steps
 * forward. If a part fails, the parts already stepped are put back, so the entry stays whole.
 */
export function compoundCommand(name: string, parts: readonly HistoryCommand[]): HistoryCommand {
  return {
    name,
    parts,
    undo: () =>
      stepParts(
        [...parts].reverse(),
        (part) => part.undo(),
        (part) => part.redo(),
      ),
    redo: () =>
      stepParts(
        parts,
        (part) => part.redo(),
        (part) => part.undo(),
      ),
    release: () => {
      for (const part of parts) part.release();
    },
  };
}

/** Runs `forward` on each part in order. On failure, `back` undoes the parts already run. */
async function stepParts(
  steps: readonly HistoryCommand[],
  forward: (part: HistoryCommand) => Promise<void>,
  back: (part: HistoryCommand) => Promise<void>,
): Promise<void> {
  const done: HistoryCommand[] = [];
  try {
    for (const part of steps) {
      await forward(part);
      done.push(part);
    }
  } catch (error) {
    for (const part of done.reverse()) await back(part).catch(() => {});
    throw error;
  }
}

/**
 * What a history item made by an editable tool remembers besides its document change (TL-FRAME-01):
 * the tool, the layer it drew on and the tool's pending state on either side of the item. Undo and
 * redo make that tool and layer active and give the tool the state of the side they land on, so a
 * result can be edited again from any of its steps, however far back.
 */
export interface ToolStep {
  /** The tool's registry id. */
  readonly tool: string;
  /** The position of the result's layer in the layer list, when the item was recorded. */
  readonly layer: number;
  /** Draw starts a result, Edit changes a pending one, Finish commits it. */
  readonly kind: "draw" | "edit" | "finish";
  /** The result the item belongs to. Every item of one result shares it. */
  readonly session: object;
  /** The tool's pending state before the item, or undefined when nothing was pending. */
  readonly before: unknown;
  /** The tool's pending state after the item, or undefined when nothing is pending. */
  readonly after: unknown;
}

/** Which way a history step is applied. */
export type StepDirection = "undo" | "redo";

/**
 * Takes part in applying history items, so tools follow the history (see `ToolStep`). `before`
 * runs before an item is undone or redone and `after` once the stacks have moved; `recorded` runs
 * after a new item is recorded. `step` is the item's tool step, if it has one.
 */
export interface HistoryStepper {
  before?(command: HistoryCommand, step: ToolStep | undefined, direction: StepDirection): unknown;
  after?(command: HistoryCommand, step: ToolStep | undefined, direction: StepDirection): unknown;
  recorded?(command: HistoryCommand, step: ToolStep | undefined): void;
}

/** Where the saved position of a history sits (see `History.savedLocation`). */
export interface SavedLocation {
  readonly depth: number;
  readonly index: number;
}

/** One line of the History panel, oldest first. */
export interface HistoryEntry {
  readonly name: string;
  /** False for items that were undone and wait on the redo stack. */
  readonly applied: boolean;
}

/**
 * The linear undo/redo history of one document (DOC-HIS-01). Undo is unlimited: items leave
 * memory through the spill store, not through a count limit. Adding an item clears the redo stack.
 *
 * The dirty state follows the saved position (DOC-DOC-06): the document is clean exactly when the
 * applied items are the same ones that were applied at the last save. Undoing back to the saved
 * position therefore cleans the document, and discarding the saved item leaves it dirty.
 */
export class History {
  readonly #applied: HistoryCommand[] = [];
  readonly #undone: HistoryCommand[] = [];
  readonly #listeners = new Set<() => void>();
  #savedDepth = 0;
  #savedTop: HistoryCommand | undefined;
  #steps = 0;
  #holds = 0;
  #chain: Promise<unknown> = Promise.resolve();
  /** The open step groups, innermost last. Items recorded inside one wait for the group to end. */
  readonly #groups: HistoryCommand[][] = [];
  /** The tool steps of the items that have one (`withStep`). */
  readonly #toolSteps = new WeakMap<HistoryCommand, ToolStep>();
  /** The tool step that items recorded now belong to. */
  #scope: ToolStep | undefined;
  #stepper: HistoryStepper | undefined;

  /** `base` adds a non-undoable first item, such as "New Image" (DOC-HIS-01). */
  constructor(base?: string) {
    if (base !== undefined) this.#applied.push(placeholderCommand(base));
    this.markSaved();
  }

  /** The name of the item the next undo steps back over, if any. */
  get undoName(): string | undefined {
    return this.canUndo ? this.#applied.at(-1)?.name : undefined;
  }

  /** The name of the item the next redo steps forward over, if any. */
  get redoName(): string | undefined {
    return this.canRedo ? this.#undone.at(-1)?.name : undefined;
  }

  /** True while an undo or redo is running or waiting to run. Changes must wait until it finishes. */
  get busy(): boolean {
    return this.#steps > 0;
  }

  get canUndo(): boolean {
    const top = this.#applied.at(-1);
    return this.#holds === 0 && top !== undefined && top.undoable !== false;
  }

  get canRedo(): boolean {
    return this.#holds === 0 && this.#undone.length > 0;
  }

  /** Every item from oldest to newest: applied items, then the redo stack in order. */
  get entries(): readonly HistoryEntry[] {
    return [
      ...this.#applied.map((command) => ({ name: command.name, applied: true })),
      ...[...this.#undone].reverse().map((command) => ({ name: command.name, applied: false })),
    ];
  }

  /** True when the applied items are exactly the ones present at the last save (DOC-DOC-06). */
  get isSaved(): boolean {
    return this.#applied.length === this.#savedDepth && this.#applied.at(-1) === this.#savedTop;
  }

  /** The applied items, oldest first (session checkpoints read them, WEB-MEM-05). */
  get appliedCommands(): readonly HistoryCommand[] {
    return this.#applied;
  }

  /** The undone items in the order they were undone. The last one is the next redo. */
  get undoneCommands(): readonly HistoryCommand[] {
    return this.#undone;
  }

  /**
   * The saved position as its depth and the index of its item in applied-then-undone order. The
   * index is -1 when the item is gone, and the depth is then -1 too, so the document stays dirty.
   */
  get savedLocation(): SavedLocation {
    if (this.#savedTop === undefined) return { depth: this.#savedDepth, index: -1 };
    const index = [...this.#applied, ...this.#undone].indexOf(this.#savedTop);
    return index < 0 ? { depth: -1, index: -1 } : { depth: this.#savedDepth, index };
  }

  /**
   * Replaces both stacks and the saved position with restored items (WEB-MEM-05). `applied` and
   * `undone` must be in the orders `appliedCommands` and `undoneCommands` give.
   */
  restore(
    applied: readonly HistoryCommand[],
    undone: readonly HistoryCommand[],
    saved: SavedLocation,
  ): void {
    this.assertIdle();
    this.#applied.splice(0, this.#applied.length, ...applied);
    this.#undone.splice(0, this.#undone.length, ...undone);
    this.#savedDepth = saved.depth;
    this.#savedTop = saved.index >= 0 ? [...applied, ...undone][saved.index] : undefined;
    this.#notify();
  }

  /** Records the current position as the saved one. */
  markSaved(): void {
    this.#savedDepth = this.#applied.length;
    this.#savedTop = this.#applied.at(-1);
    this.#notify();
  }

  /** Records that the current position is not the saved one, e.g. a file opened with changes. */
  markUnsaved(): void {
    this.#savedDepth = -1;
    this.#savedTop = undefined;
    this.#notify();
  }

  /** Adds an item after the current position. Undone items are released (DOC-HIS-01). */
  record(command: HistoryCommand): void {
    this.assertIdle();
    const open = this.#groups.at(-1);
    if (open) {
      open.push(command);
      return;
    }
    for (const undone of this.#undone.splice(0)) undone.release();
    const step = this.#scope;
    if (step !== undefined) this.#toolSteps.set(command, step);
    this.#applied.push(command);
    this.#stepper?.recorded?.(command, step);
    this.#notify();
  }

  /**
   * Runs `action` so that the items it records belong to the tool step `step` (see `ToolStep`).
   * Returns what `action` returns.
   */
  withStep<T>(step: ToolStep, action: () => T): T {
    const outer = this.#scope;
    this.#scope = step;
    try {
      return action();
    } finally {
      this.#scope = outer;
    }
  }

  /** Whether a tool is recording one of its steps right now (`withStep`). */
  get inStep(): boolean {
    return this.#scope !== undefined;
  }

  /** The tool step of an item, if a tool recorded it as one. */
  stepOf(command: HistoryCommand | undefined): ToolStep | undefined {
    return command === undefined ? undefined : this.#toolSteps.get(command);
  }

  /**
   * Records an item that changes nothing in the document, only a tool's pending state (`ToolStep`),
   * such as an edit of a result that is drawn over its layer until it is finished.
   */
  recordStep(name: string, step: ToolStep): HistoryCommand {
    const command: HistoryCommand = {
      name,
      undo: async () => {},
      redo: async () => {},
      release: () => {},
    };
    this.withStep(step, () => this.record(command));
    return command;
  }

  /** Lets `stepper` take part in undo, redo and recording. Returns the function that removes it. */
  setStepper(stepper: HistoryStepper): () => void {
    this.#stepper = stepper;
    return () => {
      if (this.#stepper === stepper) this.#stepper = undefined;
    };
  }

  /** Adds a non-undoable placeholder item, such as a "Null" item (DOC-HIS-01). */
  recordPlaceholder(name: string): void {
    this.record(placeholderCommand(name));
  }

  /**
   * DOC-HIS-01 step group: runs `action` and records the items it adds as one compound entry named
   * `name`, so one undo steps back over all of them and the History panel shows one line. Nothing
   * is recorded when `action` adds no item. If `action` throws, the items it did add are still
   * recorded, so the history keeps matching the document.
   */
  group<T>(name: string, action: () => T): T {
    this.assertIdle();
    this.#groups.push([]);
    try {
      return action();
    } finally {
      const parts = this.#groups.pop() ?? [];
      if (parts.length > 0) this.record(compoundCommand(name, parts));
    }
  }

  /**
   * Steps back one item. Returns false when there is nothing to undo. A call made while another step
   * runs waits for it, so quick repeated undos each apply in turn.
   */
  undo(): Promise<boolean> {
    return this.#queued(async () => {
      const command = this.#applied.at(-1);
      if (!this.canUndo || !command) return false;
      return this.#run(
        command,
        "undo",
        () => command.undo(),
        () => {
          this.#applied.pop();
          this.#undone.push(command);
        },
      );
    });
  }

  /**
   * Steps forward one item. Returns false when there is nothing to redo. Like `undo`, it waits for a
   * step that is running.
   */
  redo(): Promise<boolean> {
    return this.#queued(async () => {
      const command = this.#undone.at(-1);
      if (!this.canRedo || !command) return false;
      return this.#run(
        command,
        "redo",
        () => command.redo(),
        () => {
          this.#undone.pop();
          this.#applied.push(command);
        },
      );
    });
  }

  /** Undoes or redoes until `count` items are applied (the History panel's jump). */
  async seek(count: number): Promise<void> {
    while (this.#applied.length > count) {
      if (!(await this.undo())) break;
    }
    while (this.#applied.length < count) {
      if (!(await this.redo())) break;
    }
  }

  /** Releases every item and empties both stacks, e.g. when a document closes (DOC-HIS-01). */
  clear(): void {
    this.assertIdle();
    for (const command of [...this.#applied, ...this.#undone]) command.release();
    this.#applied.length = 0;
    this.#undone.length = 0;
    this.markSaved();
  }

  /** Calls `listener` after every change. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Runs `step` after the undo or redo calls made before it. A failed step does not stop the queue. */
  #queued(step: () => Promise<boolean>): Promise<boolean> {
    this.#steps += 1;
    const result = this.#chain.then(step);
    const finish = () => {
      this.#steps -= 1;
    };
    this.#chain = result.then(finish, finish);
    return result;
  }

  /**
   * Runs `act`, and moves the stacks only if it succeeds, so a failed step leaves history as it was.
   * The stepper takes part before `act` and after the move.
   */
  async #run(
    command: HistoryCommand,
    direction: StepDirection,
    act: () => Promise<void>,
    move: () => void,
  ): Promise<boolean> {
    const stepper = this.#stepper;
    const step = this.#toolSteps.get(command);
    try {
      await stepper?.before?.(command, step, direction);
      await act();
      move();
      await stepper?.after?.(command, step, direction);
      return true;
    } finally {
      this.#notify();
    }
  }

  /**
   * Blocks changes and undo or redo while a background job reads the document (DOC-IMG-02). The
   * returned function ends the hold. Holds nest, so each caller releases its own.
   */
  hold(): () => void {
    this.#holds++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.#holds--;
    };
  }

  /** Throws while an undo, a redo or a background job runs. Callers check this before they change anything. */
  assertIdle(): void {
    if (this.busy) throw new Error(BUSY_MESSAGE);
    if (this.#holds > 0) throw new Error(HELD_MESSAGE);
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}
