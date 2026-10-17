import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUSY_POLL_MS, yieldWhileBusy } from "./yield-to-host";

describe("yieldWhileBusy (L8)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("yields once when idle, and waits for the interaction to end otherwise", async () => {
    let busy = false;
    const pause = yieldWhileBusy(() => busy);
    let done = false;
    void pause().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);

    busy = true;
    done = false;
    void pause().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(BUSY_POLL_MS * 5);
    expect(done).toBe(false);
    busy = false;
    await vi.advanceTimersByTimeAsync(BUSY_POLL_MS);
    expect(done).toBe(true);
  });
});
