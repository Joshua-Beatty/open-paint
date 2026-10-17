/** A tool as the hotkey logic sees it (TL-HOTKEY-01). Tools are listed in roster order. */
export interface HotkeyTool {
  readonly id: string;
  /** A single letter. Several tools may share one (S, M, O). */
  readonly hotkey: string;
  /** Pressing the hotkey while the tool is active does nothing (TL-HOTKEY-01). */
  readonly skipIfActive: boolean;
}

/** Pressing the same letter within this window cycles to the next tool (TL-HOTKEY-01). */
export const HOTKEY_CYCLE_WINDOW_MS = 2000;

export interface HotkeyPress {
  /** The pressed letter, matched case-insensitively. */
  readonly letter: string;
  /** Shift is held, which reverses the cycling order. */
  readonly reverse: boolean;
  readonly activeId: string;
  /** When the last hotkey switch happened, or undefined before the first one. */
  readonly lastSwitchAt: number | undefined;
  readonly now: number;
  /** A pointer button is held. The tool does not switch, but the key is still consumed. */
  readonly pointerHeld: boolean;
}

export interface HotkeyResult {
  /** Whether a tool owns the letter, so the key is consumed even when nothing switches. */
  readonly consumed: boolean;
  /** The tool to switch to. Undefined when the key is consumed without a switch. */
  readonly toolId?: string;
}

/**
 * Chooses the tool a letter selects (TL-HOTKEY-01). If the letter is the active tool's hotkey and
 * the last switch was within the window, the search starts just after the active tool. Otherwise it
 * starts at the top of the list. The search wraps, and skips the active tool when it is flagged
 * skip-if-active.
 */
export function resolveHotkey(tools: readonly HotkeyTool[], press: HotkeyPress): HotkeyResult {
  const letter = press.letter.toUpperCase();
  if (!tools.some((tool) => tool.hotkey.toUpperCase() === letter)) return { consumed: false };
  if (press.pointerHeld) return { consumed: true };
  const ordered = press.reverse ? [...tools].reverse() : [...tools];
  const active = tools.find((tool) => tool.id === press.activeId);
  const withinWindow =
    press.lastSwitchAt !== undefined && press.now - press.lastSwitchAt <= HOTKEY_CYCLE_WINDOW_MS;
  const cycling = active?.hotkey.toUpperCase() === letter && withinWindow;
  const start = cycling ? ordered.findIndex((tool) => tool.id === press.activeId) + 1 : 0;
  for (let step = 0; step < ordered.length; step++) {
    const tool = ordered[(start + step) % ordered.length];
    if (tool === undefined || tool.hotkey.toUpperCase() !== letter) continue;
    if (tool.id === press.activeId && tool.skipIfActive) continue;
    return { consumed: true, toolId: tool.id };
  }
  return { consumed: true };
}
