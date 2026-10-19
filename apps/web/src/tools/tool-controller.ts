import type { ToolDescriptor, ToolRegistry, ToolRuntime } from "@openpaint/extension-api";
import { findDefinition, type SettingsStore } from "@openpaint/storage";
import { cycleChoice, resolveHotkey, stepValue } from "@openpaint/tools";
import { SHAPE_SETTING_PATH } from "./shape-catalog";
import { isStepped } from "./tool-history";

/** The setting that holds the active tool (TL-ROSTER-02, 08). */
export const ACTIVE_TOOL_PATH = "tools.activeTool";

/** The tool active on first run (TL-ROSTER-02). */
export const DEFAULT_TOOL_ID = "paintbrush";

/** The part of the settings store the tools read and write. */
export type ToolSettings = Pick<SettingsStore, "get" | "set">;

/** The tool a stored value names. A missing or unknown value gives the default tool. */
export function resolveActiveTool(registry: ToolRegistry, stored: unknown): ToolDescriptor {
  const named = typeof stored === "string" ? registry.get(stored) : undefined;
  const tool = named ?? registry.get(DEFAULT_TOOL_ID);
  if (tool === undefined)
    throw new Error(`The default tool "${DEFAULT_TOOL_ID}" is not registered.`);
  return tool;
}

export interface ToolControllerOptions {
  readonly registry: ToolRegistry;
  /**
   * Builds the runtime of a tool when it becomes active. Undefined means the tool has no pointer
   * logic yet, so the tool only shows its options and status help.
   */
  readonly createRuntime: (tool: ToolDescriptor) => ToolRuntime | undefined;
  /** The clock for the hotkey window (TL-HOTKEY-01). Defaults to `performance.now`. */
  readonly now?: () => number;
}

/**
 * The active tool and its runtime (TL-FRAME-07, TL-HOTKEY-01, TL-ROSTER-02). The active tool lives
 * in the settings store, so it survives a reload. Until the store attaches, the default tool is
 * active and nothing is stored.
 */
export class ToolController {
  readonly #registry: ToolRegistry;
  readonly #createRuntime: (tool: ToolDescriptor) => ToolRuntime | undefined;
  readonly #now: () => number;
  #settings: ToolSettings | null = null;
  #runtime: ToolRuntime | undefined;
  #runtimeTool: string | undefined;
  #lastSwitchAt: number | undefined;
  #previous: string | undefined;
  #pointerHeld = false;
  /** The settling of the tool switched away from, until it settles. */
  #leaving: Promise<void> | undefined;

  constructor(options: ToolControllerOptions) {
    this.#registry = options.registry;
    this.#createRuntime = options.createRuntime;
    this.#now = options.now ?? (() => performance.now());
  }

  /** Connects the settings store once it opens, or detaches it with null. */
  attach(settings: ToolSettings | null): void {
    this.#settings = settings;
  }

  /** The active tool. */
  get active(): ToolDescriptor {
    return resolveActiveTool(this.#registry, this.#settings?.get(ACTIVE_TOOL_PATH));
  }

  /** The tool that was active before the last switch, or undefined before the first switch. */
  get previous(): string | undefined {
    return this.#previous;
  }

  /** Whether a pointer button is held on the canvas (a drawing is in progress). */
  get pointerHeld(): boolean {
    return this.#pointerHeld;
  }

  /**
   * Whether a tool edit is in progress: a pointer is held on the canvas, or the active tool has a
   * pending result. It reads the current runtime only, so asking never creates one.
   */
  get editing(): boolean {
    return (
      this.#pointerHeld || this.#runtime?.hasPending?.() === true || this.#leaving !== undefined
    );
  }

  setPointerHeld(held: boolean): void {
    this.#pointerHeld = held;
  }

  /** The runtime of the active tool. It is replaced when the active tool changes. */
  runtime(): ToolRuntime | undefined {
    const tool = this.active;
    if (this.#runtimeTool !== tool.id) this.#replaceRuntime(tool);
    return this.#runtime;
  }

  /**
   * Makes a tool active. Switching commits the previous tool's pending result (TL-FRAME-01). Returns
   * whether the switch happened, which needs an attached settings store.
   */
  activate(id: string): boolean {
    const settings = this.#settings;
    if (settings === null || !this.#registry.has(id)) return false;
    const before = this.active.id;
    if (id === before) return true;
    this.runtime();
    settings.set(ACTIVE_TOOL_PATH, id);
    this.#previous = before;
    this.runtime();
    return true;
  }

  /**
   * Runs a letter key (TL-HOTKEY-01). Shift reverses the cycling order. Returns whether a tool owns
   * the letter, so the key is consumed even when no switch happens.
   */
  handleHotkey(letter: string, options: { readonly reverse: boolean }): boolean {
    if (this.#settings === null) return false;
    const now = this.#now();
    const result = resolveHotkey(this.#registry.list(), {
      letter,
      reverse: options.reverse,
      activeId: this.active.id,
      lastSwitchAt: this.#lastSwitchAt,
      now,
      pointerHeld: this.#pointerHeld,
    });
    if (result.toolId !== undefined) {
      this.#lastSwitchAt = now;
      this.activate(result.toolId);
    }
    return result.consumed;
  }

  /** Moves a number option of the active tool by `delta`, within its settings range (TL-HOTKEY-02). */
  stepOption(name: string, delta: number): void {
    const settings = this.#settings;
    const path = `tools.${name}`;
    const definition = findDefinition(path);
    const current = settings?.get(path);
    if (settings === null || typeof current !== "number") return;
    if (definition?.min === undefined || definition.max === undefined) return;
    settings.set(path, stepValue(current, delta, definition.min, definition.max));
  }

  /** Moves a choice option of the active tool to the next or previous choice (TL-HOTKEY-02). */
  cycleOption(name: string, step: 1 | -1): void {
    const settings = this.#settings;
    const path = `tools.${name}`;
    const choices = findDefinition(path)?.choices;
    const current = settings?.get(path);
    if (settings === null || choices === undefined || typeof current !== "string") return;
    settings.set(path, cycleChoice(choices, current, step));
  }

  /**
   * Moves the shape type to the next or previous of `names`, wrapping at the ends (TL-SHAPE-01 A and
   * Shift+A). A stored name that is not in the list starts the cycle from its beginning.
   */
  cycleShape(step: 1 | -1, names: readonly string[]): void {
    const settings = this.#settings;
    if (settings === null || names.length === 0) return;
    const stored = settings.get(SHAPE_SETTING_PATH);
    const current =
      typeof stored === "object" && stored !== null
        ? (stored as { name?: unknown }).name
        : undefined;
    const index = names.indexOf(typeof current === "string" ? current : "");
    const start = index < 0 ? (step > 0 ? -1 : 0) : index;
    const next = names[(start + step + names.length) % names.length];
    if (next !== undefined) settings.set(SHAPE_SETTING_PATH, { name: next });
  }

  /**
   * A runtime for one pointer contact with a tool other than the active one, such as the Eraser for
   * a pen's eraser end (WEB-PTR-02). The caller deactivates it when the contact ends. A pending
   * result of the active tool is committed first, as a switch would do. Undefined when the tool is
   * unknown or has no runtime.
   */
  openContactRuntime(id: string): ToolRuntime | undefined {
    const tool = this.#registry.get(id);
    if (tool === undefined) return undefined;
    const current = this.runtime();
    if (current?.hasPending?.()) current.commit?.();
    const runtime = this.#createRuntime(tool);
    runtime?.activate();
    return runtime;
  }

  /**
   * Finishes the active tool's pending result on the layer it was drawn on, as a tool switch does
   * (TL-FRAME-01: switching layer or document commits too). It reads the current runtime only, so
   * it never creates one.
   */
  finishPending(): void {
    const runtime = this.#runtime;
    if (runtime?.hasPending?.()) runtime.commit?.();
  }

  /**
   * Finishes a pending result of an editable tool whose results live in their history items, before
   * a command changes the image, so the command never lands on top of a pending result (TL-FRAME-01).
   * Other tools, such as Text, keep their result.
   */
  finishBeforeChange(): void {
    const runtime = this.#runtime;
    if (isStepped(runtime) && runtime.hasPending?.()) runtime.commit?.();
  }

  /** The active tool's runtime if it exists, without creating one. */
  current(): ToolRuntime | undefined {
    return this.#runtimeTool === this.active.id ? this.#runtime : undefined;
  }

  /**
   * Whether the active tool takes pasted text right now (UI-MENU-EDIT, the Paste fallback). It reads
   * the current runtime only, so a menu can ask while it is built without creating a runtime.
   */
  acceptsPaste(): boolean {
    return this.#runtimeTool === this.active.id && this.#runtime?.acceptsPaste?.() === true;
  }

  /** Gives pasted text to the active tool. Returns false when the tool does not take text. */
  pasteText(text: string): boolean {
    const runtime = this.runtime();
    if (runtime?.acceptsPaste?.() !== true) return false;
    runtime.paste?.(text);
    return true;
  }

  /**
   * A promise while a tool, the active one or the one switched away from, still computes a result
   * it is going to record (`ToolRuntime.settling`). Pointer input waits for it.
   */
  settling(): Promise<void> | undefined {
    return this.runtime()?.settling?.() ?? this.#leaving;
  }

  #replaceRuntime(tool: ToolDescriptor): void {
    const previous = this.#runtime;
    if (previous?.hasPending?.()) previous.commit?.();
    const leaving = previous?.settling?.();
    if (leaving !== undefined) {
      this.#leaving = leaving;
      const clear = () => {
        if (this.#leaving === leaving) this.#leaving = undefined;
      };
      leaving.then(clear, clear);
    }
    previous?.deactivate();
    this.#runtime = this.#createRuntime(tool);
    this.#runtimeTool = tool.id;
    this.#runtime?.activate();
  }
}
