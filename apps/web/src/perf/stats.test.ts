// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  distribution,
  frameStats,
  inputLatencies,
  overlayFrameLags,
  overlayLags,
  type PerfSnapshot,
  percentile,
  presentIntervals,
  previewLatencies,
  scenarioMetrics,
  tasksDuring,
} from "./stats";

const present = (end: number, work = 2) => ({ start: end - work, end });

describe("frameStats", () => {
  it("counts the frames inside the window and the gaps of 50 ms or more", () => {
    const stats = frameStats([0, 116, 132, 148, 164, 300, 400], 100, 300);
    expect(stats.framesPerSecond).toBe(25);
    expect(stats.interval.count).toBe(6);
    expect(stats.interval.max).toBe(136);
    expect(stats.long).toBe(1);
    expect(stats.longMs).toBe(136);
    expect(stats.longAt).toEqual([64]);
  });

  it("is one long gap without frames", () => {
    const stats = frameStats([], 0, 80);
    expect(stats.framesPerSecond).toBe(0);
    expect(stats.long).toBe(1);
    expect(stats.longMs).toBe(80);
  });
});

describe("percentile", () => {
  it("interpolates between the closest ranks of the sorted values", () => {
    expect(percentile([3, 1, 2, 4], 50)).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50], 95)).toBeCloseTo(48);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([1, 2, 3], 0)).toBe(1);
    expect(percentile([1, 2, 3], 100)).toBe(3);
  });

  it("is undefined for no values and clamps p to 0..100", () => {
    expect(percentile([], 50)).toBeUndefined();
    expect(percentile([1, 2], 150)).toBe(2);
  });
});

describe("distribution", () => {
  it("summarizes values, and gives nulls for an empty set", () => {
    expect(distribution([4, 1, 3, 2])).toEqual({
      count: 4,
      p50: 2.5,
      p95: expect.closeTo(3.85),
      max: 4,
    });
    expect(distribution([])).toEqual({ count: 0, p50: null, p95: null, max: null });
  });
});

describe("presentIntervals", () => {
  it("measures the gaps between presents, counting the window edges", () => {
    expect(presentIntervals([present(30), present(10), present(20), present(99)], 0, 40)).toEqual([
      10, 10, 10, 10,
    ]);
  });

  it("gives one gap as long as the window when nothing was presented", () => {
    expect(presentIntervals([present(500)], 0, 100)).toEqual([100]);
  });
});

describe("inputLatencies", () => {
  it("measures each input to the end of the first present after it", () => {
    expect(inputLatencies([5, 1, 12], [present(10), present(4), present(20)])).toEqual([3, 5, 8]);
  });

  it("leaves out inputs that no present followed", () => {
    expect(inputLatencies([1, 30], [present(10)])).toEqual([9]);
  });
});

describe("previewLatencies", () => {
  it("measures each shown preview from its request to the first present after it was shown", () => {
    const previews = [
      { requested: 0, shown: 50 },
      { requested: 40, shown: 61 },
      { requested: 90, shown: 200 },
      { requested: 300, shown: 400 },
    ];
    // The third is shown after the window; the fourth has no present after it.
    expect(previewLatencies(previews, [present(60), present(70)], 0, 100)).toEqual([60, 30]);
  });
});

describe("tasksDuring", () => {
  it("keeps the tasks overlapping the window", () => {
    const tasks = [
      { start: 0, duration: 60 },
      { start: 100, duration: 50 },
      { start: 300, duration: 70 },
    ];
    expect(tasksDuring(tasks, 50, 120)).toEqual(tasks.slice(0, 2));
  });
});

describe("scenarioMetrics", () => {
  const snapshot: PerfSnapshot = {
    engine: "v1",
    presents: [present(5), present(20), present(40), present(60), present(150), present(400)],
    inputs: [
      { kind: "pointerdown", time: 10, canvas: true },
      { kind: "pointermove", time: 30, canvas: true },
      { kind: "pointerup", time: 110, canvas: true },
      { kind: "pointermove", time: 500, canvas: true },
    ],
    longTasks: [
      { start: 50, duration: 80 },
      { start: 140, duration: 60 },
      { start: 1000, duration: 500 },
    ],
    longFrames: [{ start: 50, duration: 90, blockingDuration: 40 }],
    marks: {},
    observes: { longtask: true, longAnimationFrame: true },
  };

  it("reports the gesture between the marks and the settling until idle", () => {
    const metrics = scenarioMetrics(snapshot, { from: 0, to: 200, idleAt: 180 });
    expect(metrics.gestureMs).toBe(100);
    expect(metrics.inputs).toBe(3);
    expect(metrics.presents).toBe(3);
    expect(metrics.presentsPerSecond).toBe(30);
    expect(metrics.presentInterval).toMatchObject({ count: 4, max: 50 });
    expect(metrics.presentWork).toMatchObject({ count: 3, max: 2 });
    expect(metrics.inputLatency).toMatchObject({ count: 3, max: 40 });
    expect(metrics.longestTaskMs).toBe(80);
    expect(metrics.totalLongTaskMs).toBe(140);
    expect(metrics.longestFrameMs).toBe(90);
    expect(metrics.totalBlockingMs).toBe(40);
    expect(metrics.settleMs).toBe(70);
    expect(metrics.lastPresentMs).toBe(40);
  });

  it("reports no settle time when the app never went idle", () => {
    const metrics = scenarioMetrics(snapshot, { from: 0, to: 200, idleAt: undefined });
    expect(metrics.settleMs).toBeNull();
    expect(metrics.lastPresentMs).toBeNull();
  });
});

describe("overlay lag", () => {
  const view = (x: number) => ({ x, y: 0, zoom: 4 });
  const presents = [
    { start: 0, end: 10, view: view(0) },
    { start: 10, end: 20, view: view(5) },
    { start: 20, end: 21, view: view(5) },
    { start: 21, end: 30, view: view(9) },
  ];

  it("measures each new view from its present to the overlay draw nearest in time", () => {
    const overlays = [
      { time: 12, view: view(0) },
      { time: 19, view: view(5) },
      { time: 300, view: view(9) },
    ];
    // The repeated view(5) is not a new view; view(9) was never drawn in time.
    expect(overlayLags(presents, overlays, 0, 40)).toEqual([2, -1, 250]);
  });

  it("counts the frames between them by the paint marks", () => {
    const paints = [5, 15, 25, 35];
    const overlays = [
      { time: 12, view: view(0) },
      { time: 19, view: view(5) },
      { time: 29, view: view(9) },
    ];
    // view(0) presented at 10 shows with the paint at 15; its overlay at 12 too.
    expect(overlayFrameLags(presents, overlays, paints, 0, 40)).toEqual([0, 0, 0]);
    const late = [
      { time: 16, view: view(0) },
      { time: 26, view: view(5) },
      { time: 36, view: view(9) },
    ];
    expect(overlayFrameLags(presents, late, paints, 0, 40)).toEqual([1, 1, 1]);
  });
});
