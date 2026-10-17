import type { KeyEventLike, ShortcutPlatform } from "./keys";
import type { CommandLabels, CommandRegistry } from "./registry";

export interface CommandHandler {
  readonly run: () => void;
  /** Whether the command can run now. Defaults to true. A key still counts as bound when this is false. */
  readonly enabled?: () => boolean;
}

export interface ShortcutKeyEvent extends KeyEventLike {
  preventDefault(): void;
}

/**
 * Connects the registry to the commands that implement them. A command runs through `invoke`,
 * whether it came from a key, a menu or a button, so enable rules apply the same way everywhere
 * (WEB-KEY-02).
 */
export class ShortcutController<Id extends string> {
  readonly #registry: CommandRegistry<Id>;
  readonly #platform: ShortcutPlatform;
  readonly #handlers = new Map<Id, CommandHandler>();
  readonly #listeners = new Set<() => void>();
  #version = 0;

  constructor(registry: CommandRegistry<Id>, platform: ShortcutPlatform) {
    this.#registry = registry;
    this.#platform = platform;
  }

  get platform(): ShortcutPlatform {
    return this.#platform;
  }

  /** A counter that changes whenever a command is attached or detached. */
  get version(): number {
    return this.#version;
  }

  /**
   * Calls `listener` after a command is attached or detached, so a view that shows enable states
   * outside a menu (the toolbar) can read them again. Returns the function that stops it.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Attaches the implementation of a command. Returns the function that detaches it. */
  register(id: Id, handler: CommandHandler): () => void {
    this.#registry.get(id);
    if (this.#handlers.has(id)) throw new Error(`Command "${id}" already has a handler.`);
    this.#handlers.set(id, handler);
    this.#changed();
    return () => {
      if (this.#handlers.get(id) !== handler) return;
      this.#handlers.delete(id);
      this.#changed();
    };
  }

  #changed(): void {
    this.#version++;
    for (const listener of this.#listeners) listener();
  }

  /** Whether the command has an implementation and it can run now. Menus disable items on this. */
  isEnabled(id: Id): boolean {
    const handler = this.#handlers.get(id);
    return handler !== undefined && (handler.enabled === undefined || handler.enabled());
  }

  /** The labels a menu or the reference shows for a command, in this platform's notation. */
  labels(id: Id): CommandLabels {
    return this.#registry.labels(id, this.#platform);
  }

  /** Runs a command if it has an implementation and is enabled. Returns whether it ran. */
  invoke(id: Id): boolean {
    if (!this.isEnabled(id)) return false;
    this.#handlers.get(id)?.run();
    return true;
  }

  /**
   * Handles a keydown. A bound key is always intercepted (WEB-KEY-07), so the browser's default
   * for it does not run while the app has focus. Keys typed into a text field or a text tool are
   * left alone (WEB-KEY-05). Returns whether the key was intercepted.
   */
  handleKeyDown(event: ShortcutKeyEvent, options: { editing: boolean }): boolean {
    if (options.editing) return false;
    const id = this.#registry.find(event, this.#platform);
    if (id === undefined) return false;
    event.preventDefault();
    this.invoke(id);
    return true;
  }
}

/** Whether the key event's target is a text field, where shortcuts are suppressed (WEB-KEY-05). */
export function isEditingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !==
      null
  );
}

/** Routes window keydowns to the controller. Keys that a component already handled are skipped. */
export function listenForShortcuts<Id extends string>(
  controller: ShortcutController<Id>,
  target: Window = window,
): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    controller.handleKeyDown(event, { editing: isEditingTarget(event.target) });
  };
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}
