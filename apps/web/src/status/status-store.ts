import type { ViewLayout } from "@openpaint/engine";
import type { ReactNode } from "react";
import type { DevicePoint } from "./status-model";

/** Context text that a tool sets while it is active (UI-SB-02, "Tools can set custom status text"). */
export interface StatusHint {
  readonly text: string;
  readonly icon?: ReactNode;
}

/** The progress bar's state. A missing value means the amount is unknown (indeterminate). */
export interface StatusProgress {
  readonly value?: number;
}

export interface StatusState {
  readonly layout: ViewLayout | undefined;
  readonly pointer: DevicePoint | undefined;
  readonly hint: StatusHint | undefined;
  readonly progress: StatusProgress | undefined;
}

/**
 * The status bar's live state. The engine reports the view layout and the pointer, tools set the
 * hint, and long operations set the progress. Each change replaces `state`, so a React subscriber
 * can read it with `useSyncExternalStore` and only the status bar re-renders on pointer moves.
 */
export class StatusStore {
  #state: StatusState = {
    layout: undefined,
    pointer: undefined,
    hint: undefined,
    progress: undefined,
  };
  readonly #listeners = new Set<() => void>();

  get state(): StatusState {
    return this.#state;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** A layout equal to the current one changes nothing, so no listener runs (L3). */
  setLayout(layout: ViewLayout | undefined): void {
    if (sameLayout(this.#state.layout, layout)) return;
    this.#update({ layout });
  }

  setPointer(pointer: DevicePoint | undefined): void {
    const current = this.#state.pointer;
    if (current === pointer) return;
    if (current !== undefined && pointer !== undefined) {
      if (current.x === pointer.x && current.y === pointer.y) return;
    }
    this.#update({ pointer });
  }

  /** Tools set their text on every preview frame; the same text again changes nothing (L3). */
  setHint(hint: StatusHint | undefined): void {
    const current = this.#state.hint;
    if (current === hint) return;
    if (current !== undefined && hint !== undefined) {
      if (current.text === hint.text && current.icon === hint.icon) return;
    }
    this.#update({ hint });
  }

  setProgress(progress: StatusProgress | undefined): void {
    this.#update({ progress });
  }

  #update(patch: Partial<StatusState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
}

function sameLayout(a: ViewLayout | undefined, b: ViewLayout | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return (
    a.mode === b.mode &&
    a.zoom === b.zoom &&
    a.originX === b.originX &&
    a.originY === b.originY &&
    a.documentWidth === b.documentWidth &&
    a.documentHeight === b.documentHeight
  );
}
