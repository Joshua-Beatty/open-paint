// @vitest-environment node
import { describe, expect, it } from "vitest";
import { analyze, type Spike } from "./analyze.ts";
import { clockMark, drag, emptyApp, MAIN, presents, profile, task, us } from "./fixtures.ts";
import { formatOffset, formatReport, type SessionInfo, summarizeSpikes } from "./report.ts";

const SESSION: SessionInfo = {
  date: "2026-10-14T20:00:00.000Z",
  url: "http://127.0.0.1:4000/?perf=1&engine=v1",
  engine: "v1",
  mode: "a production build with source maps, served by vite preview",
  browser: "Chromium 156",
  backend: "webgpu",
  ended: "Enter in the terminal",
  sourceMaps: "3 of 3 profiled scripts had a source map",
  notes: ["A note."],
};

const FRAMES = {
  composite: {
    functionName: "composite",
    url: "http://app/src/composite.ts",
    lineNumber: 4,
    columnNumber: 0,
  },
};

describe("formatOffset and summarizeSpikes", () => {
  it("formats offsets as m:ss.SSS", () => {
    expect(formatOffset(0)).toBe("0:00.000");
    expect(formatOffset(61_234.25)).toBe("1:01.234");
    expect(formatOffset(600_000)).toBe("10:00.000");
  });

  it("summarizes many signals by kind", () => {
    const spike = (
      kind: Spike["kind"],
      durationMs: number,
      thread: Spike["thread"] = "main",
    ): Spike => ({
      kind,
      thread,
      start: 0,
      end: 1,
      durationMs,
    });
    expect(
      summarizeSpikes([
        spike("frame", 60),
        spike("frame", 90),
        spike("task", 70, "engine"),
        spike("latency", 55),
      ]),
    ).toBe(
      "2 long animation frames (worst 90.0 ms), 1 long task on engine worker (worst 70.0 ms), 1 input latency spike (worst 55.0 ms)",
    );
  });
});

describe("formatReport", () => {
  it("writes the summary, the worst spikes, the hot functions and every spike", () => {
    const samples = Array.from({ length: 100 }, () => "composite");
    const analysis = analyze(
      [
        clockMark(0),
        task(MAIN, 1000, 100),
        task(MAIN, 3000, 60),
        ...profile(MAIN, "0x1", 1000, 1, FRAMES, samples),
      ],
      emptyApp({
        inputs: drag(900, 1200),
        presents: presents(900, 1300),
        tools: [{ time: 0, tool: "Paintbrush" }],
      }),
    );
    const report = formatReport(analysis, SESSION);
    expect(report).toContain("# Lag report, 2026-10-14T20:00:00.000Z");
    expect(report).toContain("| Lag spikes (overlapping signals grouped) | 2 |");
    expect(report).toContain(
      "| Long tasks on main | 2, total 160 ms, longest 100 ms, blocking 60.0 ms |",
    );
    expect(report).toContain("- **Note:** A note.");
    expect(report).toContain("### Worst 10");
    expect(report).toMatch(
      /\| \[1\]\(#1-[^)]+\) \| 0:\d\d\.\d{3} \| 100 ms \| long task 100 ms on main \|/,
    );
    expect(report).toContain("### Hot functions across all spikes");
    expect(report).toContain("| composite | /src/composite.ts:5:1 | app | 100 ms | 100 % |");
    expect(report).toContain("- **Doing:** pointer drag on canvas · **Tool:** Paintbrush");
    expect(report).toContain("### 2. ");
    expect(report).toContain("No CPU samples in this window.");
    expect(report.indexOf("### 1. ")).toBeLessThan(report.indexOf("### 2. "));
    expect(analysis.incidents[0]?.start).toBe(us(1000));
  });

  it("says so when nothing lagged", () => {
    const report = formatReport(analyze([clockMark(0)], emptyApp()), SESSION);
    expect(report).toContain("No lag spikes: nothing reached 50 ms.");
    expect(report).not.toContain("### Worst 10");
  });
});
