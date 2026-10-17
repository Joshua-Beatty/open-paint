import { OutOfMemoryError } from "@openpaint/document";

/** Why an effect did not complete (FX-FW-ERR-01). */
export type EffectFailure = "outOfMemory" | "failed";

/**
 * An effect that could not be applied. The layer has been restored to its state before the effect
 * started, so the caller only has to report the error.
 */
export class EffectError extends Error {
  readonly effectId: string;
  readonly failure: EffectFailure;

  constructor(effectId: string, failure: EffectFailure, cause?: unknown) {
    super(`Effect "${effectId}" ${failure === "outOfMemory" ? "ran out of memory" : "failed"}.`, {
      cause,
    });
    this.name = "EffectError";
    this.effectId = effectId;
    this.failure = failure;
  }
}

/** Maps any error from a render or commit to an `EffectError`, keeping an existing one. */
export function toEffectError(effectId: string, cause: unknown): EffectError {
  if (cause instanceof EffectError) return cause;
  return new EffectError(
    effectId,
    cause instanceof OutOfMemoryError ? "outOfMemory" : "failed",
    cause,
  );
}
