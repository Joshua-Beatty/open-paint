import type { EngineHandle, EnginePerfReport } from "@openpaint/engine";
import { describe, expect, it, vi } from "vitest";
import { perfFlags } from "./flags";
import { PerfMonitor } from "./perf-monitor";

/** An engine handle with only the perf calls, reporting from a scope that started 100 ms later. */
function fakeEngine(reports: EnginePerfReport[]) {
  let listener: ((report: EnginePerfReport) => void) | undefined;
  const engine = {
    perf: vi.fn(async () => reports.shift() ?? { timeOrigin: 0, presents: [], idle: true }),
    onPerf: (next: (report: EnginePerfReport) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
  return {
    engine: engine as unknown as EngineHandle,
    emit: (report: EnginePerfReport) => listener?.(report),
  };
}

describe("perfFlags", () => {
  it("is off unless the parameters ask for it, and files results under v1 by default", () => {
    expect(perfFlags("")).toEqual({ perf: false, bench: false, engine: "v1" });
    expect(perfFlags("?perf=1&bench=1&engine=v2")).toEqual({
      perf: true,
      bench: true,
      engine: "v2",
    });
    expect(perfFlags("?perf=0").perf).toBe(false);
    expect(perfFlags("").gpuFault).toBeUndefined();
    expect(perfFlags("?gpu-fault=present").gpuFault).toBe("present");
  });
});

describe("PerfMonitor", () => {
  it("moves the engine's present times onto the main thread's clock", async () => {
    const origin = performance.timeOrigin + 100;
    const { engine, emit } = fakeEngine([{ timeOrigin: origin, presents: [5, 7], idle: true }]);
    const monitor = new PerfMonitor("v1");
    monitor.attachEngine(engine);
    emit({ timeOrigin: origin, presents: [1, 2, 3, 4], idle: false });
    const snapshot = await monitor.snapshot();
    expect(snapshot.engine).toBe("v1");
    expect(snapshot.presents.map(({ start, end }) => [start, end])).toEqual([
      [101, 102],
      [103, 104],
      [105, 107],
    ]);
    monitor.reset();
    expect((await monitor.snapshot()).presents).toEqual([]);
  });

  it("is idle only once the engine and every idle check agree on two frames in a row", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0));
    const busy = { timeOrigin: performance.timeOrigin, presents: [], idle: false };
    const { engine } = fakeEngine([busy, busy]);
    const monitor = new PerfMonitor("v1");
    monitor.attachEngine(engine);
    let historyBusy = true;
    monitor.addIdleCheck(() => !historyBusy);
    setTimeout(() => {
      historyBusy = false;
    }, 20);
    const result = await monitor.idle(5_000);
    expect(result.idle).toBe(true);
    // Two busy replies, then at least two idle frames in a row.
    expect(vi.mocked(engine.perf).mock.calls.length).toBeGreaterThanOrEqual(4);
    vi.unstubAllGlobals();
  });

  it("exposes __openpaintPerf and records key presses without their modifiers", async () => {
    const monitor = new PerfMonitor("v2");
    monitor.install(window);
    expect(window.__openpaintPerf).toBeDefined();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "=", ctrlKey: true }));
    const at = window.__openpaintPerf?.mark("end");
    const snapshot = await window.__openpaintPerf?.snapshot();
    expect(snapshot?.inputs.map((input) => input.kind)).toEqual(["keydown"]);
    expect(snapshot?.marks.end).toBe(at);
    expect(snapshot?.engine).toBe("v2");
    delete window.__openpaintPerf;
  });

  it("records wheel input and whether pointer samples drag, and take() forgets what it returns", async () => {
    const monitor = new PerfMonitor("v1");
    const target = new EventTarget() as unknown as Window;
    monitor.install(target);
    target.dispatchEvent(new MouseEvent("pointermove", { buttons: 0 }));
    target.dispatchEvent(new MouseEvent("pointerdown", { buttons: 1 }));
    target.dispatchEvent(new MouseEvent("pointermove", { buttons: 1 }));
    target.dispatchEvent(new MouseEvent("pointerup", { buttons: 0 }));
    target.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
    const taken = await target.__openpaintPerf?.take();
    expect(taken?.inputs.map(({ kind, drag }) => [kind, drag])).toEqual([
      ["pointermove", false],
      ["pointerdown", true],
      ["pointermove", true],
      ["pointerup", true],
      ["wheel", undefined],
    ]);
    expect((await monitor.snapshot()).inputs).toEqual([]);
  });

  it("gives up after the timeout", async () => {
    const { engine } = fakeEngine([]);
    const monitor = new PerfMonitor("v1");
    monitor.attachEngine(engine);
    monitor.addIdleCheck(() => false);
    expect((await monitor.idle(30)).idle).toBe(false);
  });
});
