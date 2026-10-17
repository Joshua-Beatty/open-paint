/** What Enter or Esc does right now (TL-FRAME-01, TL-HOTKEY-03). */
export type EscapeAction = "cancelDrawing" | "commit" | "deselect" | "none";

export interface EscapeState {
  /** A pointer gesture is in progress. */
  readonly drawing: boolean;
  /** The tool has a result that is drawn but not committed (Dirty or Editing). */
  readonly pending: boolean;
  /** A selection exists, so Deselect has something to do. */
  readonly canDeselect: boolean;
}

/**
 * The shared Enter and Esc rules. A drawing in progress is cancelled first, then a pending result
 * is committed. With neither, and no pointer held, a selection is deselected.
 */
export function escapeAction(state: EscapeState): EscapeAction {
  if (state.drawing) return "cancelDrawing";
  if (state.pending) return "commit";
  if (state.canDeselect) return "deselect";
  return "none";
}

export interface CommitKeyEvent {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

/** Enter or Esc with no Ctrl, Shift, Alt or Meta held (TL-FRAME-01). */
export function isCommitKey(event: CommitKeyEvent): boolean {
  const key = event.code === "Enter" || event.code === "NumpadEnter" || event.code === "Escape";
  return key && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
}
