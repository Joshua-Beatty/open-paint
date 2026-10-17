/**
 * Lets the rest of the app run before the next slice of background work, so no slice holds the
 * main thread for long (PRD-NF-02).
 */
export function yieldToHost(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** How often background work that waits for an interaction checks whether it ended. */
export const BUSY_POLL_MS = 100;

/**
 * A pause for background work that also waits while `busy()` holds, such as while the user draws,
 * so the work never competes with the interaction for the main thread (L8).
 */
export function yieldWhileBusy(busy: () => boolean): () => Promise<void> {
  return async () => {
    await yieldToHost();
    while (busy()) await new Promise((resolve) => setTimeout(resolve, BUSY_POLL_MS));
  };
}
