import type { ResampleRunner } from "./resample";

/**
 * Progress and cancellation for a long document operation (DOC-IMG-02, FX-FW-PROGRESS-01). The
 * document package has no DOM types, so the signal is a plain callback.
 */
export interface JobControl {
  /** Resamples each layer somewhere other than this thread. Undefined resamples here. */
  readonly resample?: ResampleRunner;
  /** Asked between slices. True stops the job, which leaves the document unchanged. */
  readonly isCanceled?: () => boolean;
  /** Receives the fraction done, from 0 to 1, after each slice. */
  readonly onProgress?: (fraction: number) => void;
  /** Lets the caller run other work (such as the UI) between slices. */
  readonly pause?: () => Promise<void>;
}

/** Thrown when a job stops because it was canceled. The document is unchanged. */
export class OperationCanceledError extends Error {
  constructor() {
    super("The operation was canceled.");
    this.name = "OperationCanceledError";
  }
}

export function throwIfCanceled(control: JobControl): void {
  if (control.isCanceled?.() === true) throw new OperationCanceledError();
}
