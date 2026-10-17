import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERF_FLUSH_MS, PRESENT_MEASURE, PresentRecorder } from "./perf";

describe("PresentRecorder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("batches presents and emits them once per interval", () => {
    const emit = vi.fn();
    const recorder = new PresentRecorder(emit);
    recorder.record(1, 2);
    recorder.record(5, 7);
    expect(emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PERF_FLUSH_MS);
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      presents: [1, 2, 5, 7],
      views: [Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN],
    });
    recorder.record(10, 11, { originX: -4, originY: 2, zoom: 3 });
    vi.advanceTimersByTime(PERF_FLUSH_MS);
    expect(emit).toHaveBeenLastCalledWith({ presents: [10, 11], views: [-4, 2, 3] });
  });

  it("drains the batch on take, so the timer has nothing left to send", () => {
    const emit = vi.fn();
    const recorder = new PresentRecorder(emit);
    recorder.record(1, 2);
    expect(recorder.take().presents).toEqual([1, 2]);
    expect(recorder.take()).toEqual({ presents: [], views: [] });
    vi.advanceTimersByTime(PERF_FLUSH_MS * 2);
    expect(emit).not.toHaveBeenCalled();
  });

  it("leaves a user timing measure per present for traces, and clears it", () => {
    const measure = vi.spyOn(performance, "measure");
    const recorder = new PresentRecorder(vi.fn());
    recorder.record(1, 3);
    expect(measure).toHaveBeenCalledWith(PRESENT_MEASURE, { start: 1, end: 3 });
    expect(performance.getEntriesByName(PRESENT_MEASURE)).toEqual([]);
    recorder.take();
    measure.mockRestore();
  });
});
