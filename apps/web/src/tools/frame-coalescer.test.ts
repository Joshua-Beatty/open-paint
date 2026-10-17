import { describe, expect, it } from "vitest";
import { FrameCoalescer } from "./frame-coalescer";

function scheduler() {
  const frames: (() => void)[] = [];
  return {
    frames,
    schedule: (callback: () => void) => {
      frames.push(callback);
      return () => {
        const at = frames.indexOf(callback);
        if (at >= 0) frames.splice(at, 1);
      };
    },
  };
}

describe("FrameCoalescer", () => {
  it("runs only the latest request, once, on the next frame", () => {
    const { frames, schedule } = scheduler();
    const coalescer = new FrameCoalescer(schedule);
    const ran: number[] = [];
    for (const n of [1, 2, 3]) coalescer.request(() => ran.push(n));
    expect(frames).toHaveLength(1);
    expect(coalescer.pending).toBe(true);
    frames.shift()?.();
    expect(ran).toEqual([3]);
    expect(coalescer.pending).toBe(false);
  });

  it("flushes pending work now and cancels its frame", () => {
    const { frames, schedule } = scheduler();
    const coalescer = new FrameCoalescer(schedule);
    const ran: number[] = [];
    coalescer.request(() => ran.push(1));
    coalescer.flush();
    expect(ran).toEqual([1]);
    expect(frames).toHaveLength(0);
  });

  it("drops pending work on cancel", () => {
    const { frames, schedule } = scheduler();
    const coalescer = new FrameCoalescer(schedule);
    const ran: number[] = [];
    coalescer.request(() => ran.push(1));
    coalescer.cancel();
    expect(frames).toHaveLength(0);
    coalescer.flush();
    expect(ran).toEqual([]);
  });

  it("runs at once without a scheduler", () => {
    const coalescer = new FrameCoalescer(undefined);
    const ran: number[] = [];
    coalescer.request(() => ran.push(1));
    expect(ran).toEqual([1]);
    expect(coalescer.pending).toBe(false);
  });
});
