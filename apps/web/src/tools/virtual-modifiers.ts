import type { PointerSource } from "@openpaint/tools";

/** The on-screen stand-ins for keys and the right button, for touch and pen input. */
export type VirtualKey = "shift" | "ctrl" | "alt" | "secondary";

export type VirtualModifierState = Readonly<Record<VirtualKey, boolean>>;

export const NO_VIRTUAL_MODIFIERS: VirtualModifierState = {
  shift: false,
  ctrl: false,
  alt: false,
  secondary: false,
};

/** The primary and secondary button bits of `PointerEvent.buttons`. */
const PRIMARY_BIT = 1;
const SECONDARY_BIT = 2;

/**
 * The on-screen modifier toggles (Shift, Ctrl, Alt and the right button). Each one stays on until
 * it is turned off, and applies to every press on the canvas meanwhile. A store, so the toggle bar
 * renders from it without the app shell re-rendering (L3).
 */
export class VirtualModifiers {
  #state: VirtualModifierState = NO_VIRTUAL_MODIFIERS;
  readonly #listeners = new Set<() => void>();

  get state(): VirtualModifierState {
    return this.#state;
  }

  toggle(key: VirtualKey): void {
    this.#state = { ...this.#state, [key]: !this.#state[key] };
    for (const listener of this.#listeners) listener();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
}

function anyOn(state: VirtualModifierState): boolean {
  return state.shift || state.ctrl || state.alt || state.secondary;
}

/**
 * The pointer as the tools see it with the toggles applied: the held keys are added to the
 * event's own, and while the right-button toggle is on a primary press becomes a secondary one
 * (`button` 0 to 2, `buttons` bit 1 to bit 2). Coalesced and predicted samples get the same.
 */
export function withVirtualModifiers(
  source: PointerSource,
  state: VirtualModifierState,
): PointerSource {
  if (!anyOn(state)) return source;
  const map = (event: PointerSource): PointerSource => {
    const buttons = event.buttons;
    return {
      clientX: event.clientX,
      clientY: event.clientY,
      pressure: event.pressure,
      pointerType: event.pointerType,
      button: state.secondary && event.button === 0 ? 2 : event.button,
      ...(buttons !== undefined && {
        buttons:
          state.secondary && (buttons & PRIMARY_BIT) !== 0
            ? (buttons & ~PRIMARY_BIT) | SECONDARY_BIT
            : buttons,
      }),
      shiftKey: event.shiftKey || state.shift,
      ctrlKey: event.ctrlKey || state.ctrl,
      altKey: event.altKey || state.alt,
    };
  };
  const coalesced = source.getCoalescedEvents?.bind(source);
  const predicted = source.getPredictedEvents?.bind(source);
  return {
    ...map(source),
    ...(coalesced !== undefined && { getCoalescedEvents: () => coalesced().map(map) }),
    ...(predicted !== undefined && { getPredictedEvents: () => predicted().map(map) }),
  };
}
