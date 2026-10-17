// @vitest-environment node
import { describe, expect, it } from "vitest";
import { scenarioMetrics } from "../src/perf/stats.ts";
import {
  type BenchResults,
  formatComparison,
  formatTable,
  resultsFileName,
  speedup,
} from "./report.ts";

describe("resultsFileName", () => {
  it("names the file after the engine and the UTC time, without colons", () => {
    expect(resultsFileName("v1", new Date("2026-10-13T08:09:10.123Z"))).toBe(
      "v1-2026-10-13T08-09-10Z.json",
    );
  });
});

describe("formatTable", () => {
  it("prints one Markdown row per scenario, marking unfinished and failed ones", () => {
    const metrics = scenarioMetrics(
      {
        engine: "v1",
        presents: [
          { start: 0, end: 10 },
          { start: 15, end: 20 },
          { start: 40, end: 50 },
        ],
        inputs: [
          { kind: "pointerdown", time: 0, canvas: true },
          { kind: "pointerup", time: 20, canvas: true },
        ],
        longTasks: [],
        longFrames: [],
        marks: {},
        observes: { longtask: true, longAnimationFrame: true },
      },
      { from: 0, to: 100, idleAt: 60 },
    );
    const results: BenchResults = {
      engine: "v1",
      date: "2026-10-13",
      browser: "test",
      backend: "webgpu",
      adapter: undefined,
      viewport: { width: 1440, height: 900 },
      devicePixelRatio: 1,
      scenarios: [
        {
          id: "B1",
          title: "stroke",
          setup: {},
          metrics,
          frames: {
            framesPerSecond: 60,
            interval: { count: 3, p50: 16, p95: 16, max: 52 },
            long: 1,
            longMs: 52,
          },
          timedOut: false,
        },
        { id: "B2", title: "stroke", setup: {}, metrics, timedOut: true, notes: ["a", "b"] },
        { id: "B3", title: "stroke", setup: {}, metrics: null, timedOut: false, error: "crashed" },
      ],
    };
    const lines = formatTable(results).split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[2]).toBe(
      "| B1 | 100.0 | 10.0 / 10.0 / 10.0 | 5.0 / 9.5 | 0.0 | 0.0 | 40.0 | 60, 16.0 / 52.0, 1 (52.0) |  |",
    );
    expect(lines[3]).toContain("| > cap | - | a; b |");
    expect(lines[4]).toContain("| B3 | crashed |");
  });
});

describe("formatComparison", () => {
  it("shows both values and the speedup per metric, higher or lower being better", () => {
    expect(speedup(10, 120, true)).toBe("12×");
    expect(speedup(200, 50, false)).toBe("4.0×");
    expect(speedup(300, 0, false)).toBe("∞");
    expect(speedup(0, 0, false)).toBe("-");

    const base = scenarioMetrics(
      {
        engine: "v",
        presents: [],
        inputs: [],
        longTasks: [],
        longFrames: [],
        marks: {},
        observes: { longtask: true, longAnimationFrame: true },
      },
      { from: 0, to: 100, idleAt: 100 },
    );
    const metrics = (presents: number, settle: number) => ({
      ...base,
      presentsPerSecond: presents * 10,
      settleMs: settle,
    });
    const results = (engine: string, presents: number, settle: number): BenchResults => ({
      engine,
      date: "2026-10-13",
      browser: "test",
      backend: "webgpu",
      adapter: undefined,
      viewport: { width: 1440, height: 900 },
      devicePixelRatio: 1,
      scenarios: [
        { id: "B1", title: "s", setup: {}, metrics: metrics(presents, settle), timedOut: false },
        { id: "B2", title: "s", setup: {}, metrics: null, timedOut: false, error: "x" },
      ],
    });
    const lines = formatComparison(results("v1", 4, 400), results("v2", 40, 20)).split("\n");
    expect(lines[0]).toContain("Presents/s v1 → v2");
    expect(lines[2]).toContain("| 40.0 → 400.0 (10×) |");
    expect(lines[2]).toContain("| 400 → 20.0 (20×) |");
    expect(lines[3]).toContain("not run");
  });
});
