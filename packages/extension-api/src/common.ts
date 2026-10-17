/** Id of an icon asset (PNG or SVG) that ships with the app (EXT-02-02). */
export type IconId = string;

/** Cooperative cancellation state of a render job (EXT-03-08). */
export interface CancellationState {
  readonly isCancelRequested: boolean;
}

/** Throws the canonical cancellation error when cancellation was requested (EXT-03-08). */
export function throwIfCancelRequested(state: CancellationState): void {
  if (state.isCancelRequested) {
    throw new Error("operation canceled");
  }
}

/** Reports progress as a fraction in [0, 1]. The reporter may throw to stop the work. */
export type ProgressReporter = (fraction: number) => void;
