/** One open image as the close rules see it. */
export interface CloseCandidate {
  readonly id: string;
  readonly dirty: boolean;
}

/** The images one close request covers, in tab order, and the unsaved ones among them. */
export interface ClosePlan {
  readonly ids: readonly string[];
  readonly dirty: readonly string[];
}

/** Plans a close over the candidates in tab order (UI-DOC-03, UI-DOC-04). */
export function planClose(candidates: readonly CloseCandidate[]): ClosePlan {
  return {
    ids: candidates.map((candidate) => candidate.id),
    dirty: candidates.filter((candidate) => candidate.dirty).map((candidate) => candidate.id),
  };
}

/** True while any open image has changes that have not been saved (WEB-UI-06). */
export function hasUnsavedImages(candidates: readonly CloseCandidate[]): boolean {
  return candidates.some((candidate) => candidate.dirty);
}
