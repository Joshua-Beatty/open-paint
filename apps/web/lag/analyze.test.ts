// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  analyze,
  describeActivity,
  findThreads,
  gestures,
  groupSpikes,
  isEngineWorkerUrl,
  parseProfiles,
  plainResolver,
  presentSpikes,
  rankFunctions,
  type Spike,
  threadTasks,
  toolAt,
} from "./analyze.ts";
import {
  clockMark,
  drag,
  ENGINE,
  emptyApp,
  MAIN,
  PAGE_ORIGIN,
  type ProfileFrame,
  presentMeasure,
  presents,
  profile,
  task,
  threadName,
  us,
} from "./fixtures.ts";

const FRAMES: Record<string, ProfileFrame> = {
  onPointer: {
    functionName: "onPointer",
    url: "http://app/src/tools/tool-pointer.ts",
    lineNumber: 40,
    columnNumber: 2,
  },
  renderStroke: {
    functionName: "renderStroke",
    url: "http://app/packages/tools/src/brush.ts",
    lineNumber: 9,
    columnNumber: 0,
    parent: "onPointer",
  },
  commitRoot: {
    functionName: "commitRoot",
    url: "http://app/node_modules/.pnpm/react-dom@19/node_modules/react-dom/cjs/client.js",
    lineNumber: 99,
    columnNumber: 4,
  },
  gc: { functionName: "(garbage collector)" },
  idle: { functionName: "(idle)" },
};

const toTrace = (ms: number) => us(ms);

describe("findThreads", () => {
  it("takes the main thread from the clock mark and the engine from its present measures", () => {
    const threads = findThreads([
      clockMark(0),
      presentMeasure(5),
      threadName(MAIN, "CrRendererMain"),
    ]);
    expect(threads).toEqual({ main: MAIN, engine: ENGINE });
  });

  it("falls back to the busiest renderer main thread and the engine worker's script URL", () => {
    const other = { pid: 2, tid: 30 };
    const threads = findThreads([
      threadName(MAIN, "CrRendererMain"),
      threadName(other, "CrRendererMain"),
      task(MAIN, 0, 30),
      task(other, 0, 5),
      {
        name: "TracingSessionIdForWorker",
        ph: "I",
        ts: 1,
        ...MAIN,
        args: { data: { url: "http://app/assets/cpu-worker-x1.js", workerThreadId: 21 } },
      },
      {
        name: "TracingSessionIdForWorker",
        ph: "I",
        ts: 1,
        ...MAIN,
        args: { data: { url: "http://app/assets/worker-AbC_9.js", workerThreadId: 20 } },
      },
    ]);
    expect(threads).toEqual({ main: MAIN, engine: ENGINE });
  });

  it("recognizes the engine worker script in dev and built form only", () => {
    expect(isEngineWorkerUrl("http://x/assets/worker-l-s3tGZV.js")).toBe(true);
    expect(
      isEngineWorkerUrl(
        "http://x/@fs/C:/repo/packages/engine/src/worker.ts?worker_file&type=module",
      ),
    ).toBe(true);
    expect(isEngineWorkerUrl("http://x/assets/spill-worker-BSPAr4cH.js")).toBe(false);
    expect(isEngineWorkerUrl("http://x/sw.js")).toBe(false);
  });
});

describe("threadTasks", () => {
  it("keeps the top-level tasks of one thread and drops nested ones", () => {
    const tasks = threadTasks(
      [task(MAIN, 0, 100), task(MAIN, 10, 20), task(ENGINE, 0, 80), task(MAIN, 200, 10)],
      MAIN,
    );
    expect(tasks).toEqual([
      { start: us(0), end: us(100) },
      { start: us(200), end: us(210) },
    ]);
  });
});

describe("parseProfiles", () => {
  it("joins chunked nodes and time deltas into one profile per thread", () => {
    const [main] = parseProfiles(
      profile(MAIN, "0x1", 0, 1, FRAMES, ["onPointer", "renderStroke", "renderStroke"]),
    );
    expect(main?.thread).toEqual(MAIN);
    expect(main?.times).toEqual([us(0), us(1), us(2)]);
    expect(main?.samples.map((node) => main.nodes.get(node)?.frame.functionName)).toEqual([
      "onPointer",
      "renderStroke",
      "renderStroke",
    ]);
    const leaf = main?.samples[1] as number;
    const parent = main?.nodes.get(leaf)?.parent as number;
    expect(main?.nodes.get(parent)?.frame.functionName).toBe("onPointer");
  });

  it("keeps the profiles of different threads apart by profile id", () => {
    const profiles = parseProfiles([
      ...profile(MAIN, "0x1", 0, 1, FRAMES, ["onPointer"]),
      ...profile(ENGINE, "0x2", 0, 1, FRAMES, ["commitRoot", "commitRoot"]),
    ]);
    expect(profiles.map((p) => [p.thread.tid, p.samples.length])).toEqual([
      [MAIN.tid, 1],
      [ENGINE.tid, 2],
    ]);
  });
});

describe("plainResolver and rankFunctions", () => {
  it("classifies our code, libraries, wasm and VM entries", () => {
    expect(plainResolver(FRAMES.renderStroke as ProfileFrame)).toEqual({
      name: "renderStroke",
      location: "/packages/tools/src/brush.ts:10:1",
      origin: "app",
    });
    expect(plainResolver(FRAMES.commitRoot as ProfileFrame)).toMatchObject({
      location: "react-dom/cjs/client.js:100:5",
      origin: "lib",
    });
    expect(
      plainResolver({ functionName: "wasm-function[155]", url: "http://app/assets/cpu_bg-1.wasm" }),
    ).toEqual({
      name: "wasm-function[155]",
      location: "cpu_bg-1.wasm",
      origin: "wasm",
    });
    expect(plainResolver({ functionName: "(garbage collector)" }).origin).toBe("vm");
    expect(plainResolver({ functionName: "postMessage", url: "" }).location).toBe("(native)");
  });

  it("lists our functions first, each group by time", () => {
    const frame = (name: string, origin: "app" | "lib" | "vm") => ({ name, location: "", origin });
    const ranked = rankFunctions(
      [
        { frame: frame("lib big", "lib"), us: 9000 },
        { frame: frame("ours small", "app"), us: 1000 },
        { frame: frame("ours big", "app"), us: 5000 },
        { frame: frame("gc", "vm"), us: 3000 },
      ],
      6,
      1,
    );
    expect(ranked.map((entry) => [entry.name, entry.ms])).toEqual([
      ["ours big", 5],
      ["ours small", 1],
      ["lib big", 9],
    ]);
  });
});

describe("gestures and presentSpikes", () => {
  it("finds drags and canvas wheel bursts", () => {
    const found = gestures(
      [
        ...drag(0, 100),
        { kind: "pointermove", time: 150, canvas: true, drag: false },
        { kind: "wheel", time: 200, canvas: true },
        { kind: "wheel", time: 250, canvas: true },
        { kind: "wheel", time: 600, canvas: true },
      ],
      toTrace,
    );
    expect(
      found.map((g) => [
        g.kind,
        (g.start - PAGE_ORIGIN) / 1000,
        (g.end - PAGE_ORIGIN) / 1000,
        g.inputs.length,
      ]),
    ).toEqual([
      ["drag", 0, 100, 13],
      ["wheel", 200, 350, 2],
      ["wheel", 600, 700, 1],
    ]);
  });

  it("reports a gap while moves keep coming and the latency of the inputs that waited", () => {
    // Presents every 16 ms, except none from 100 to 220 ms while the drag goes on.
    const ends = [...presents(0, 96), ...presents(220, 400)].map((p) => toTrace(p.end));
    const [stroke] = gestures(drag(0, 400), toTrace);
    const { gaps, latency } = presentSpikes(ends, stroke ? [stroke] : []);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ kind: "present-gap", start: us(104), end: us(220) });
    expect(gaps[0]?.durationMs).toBeCloseTo(116);
    // Inputs from 104 to 168 waited at least 50 ms for the present at 220; one spike for it.
    expect(latency).toHaveLength(1);
    expect(latency[0]).toMatchObject({ kind: "latency", start: us(104), end: us(220), extra: 9 });
    expect(latency[0]?.durationMs).toBeCloseTo(116);
  });

  it("does not count a pause in a drag, or a drag the engine never presented", () => {
    const pause = [
      ...drag(0, 40),
      ...drag(500, 540).slice(1), // moves resume at 508 after the button was held still
    ].filter((input) => input.kind !== "pointerup" || input.time === 540);
    const ends = [...presents(0, 48), ...presents(512, 560)].map((p) => toTrace(p.end));
    const held = gestures(pause, toTrace);
    expect(held).toHaveLength(1);
    expect(presentSpikes(ends, held).gaps).toEqual([]);
    const overlayOnly = gestures(drag(1000, 1400), toTrace);
    expect(presentSpikes(ends, overlayOnly)).toEqual({ gaps: [], latency: [] });
  });
});

describe("groupSpikes, describeActivity and toolAt", () => {
  const spike = (start: number, end: number): Spike => ({
    kind: "task",
    thread: "main",
    start,
    end,
    durationMs: (end - start) / 1000,
  });

  it("groups overlapping spikes and keeps separate ones apart", () => {
    const groups = groupSpikes([spike(300, 400), spike(0, 100), spike(50, 200), spike(200, 250)]);
    expect(groups.map((group) => group.map((s) => s.start))).toEqual([[0, 50, 200], [300]]);
  });

  it("says what the user was doing in a window", () => {
    const inputs = [
      ...drag(0, 1000),
      { kind: "keydown" as const, time: 1500, canvas: false },
      { kind: "wheel" as const, time: 2000, canvas: true },
      { kind: "pointermove" as const, time: 3000, canvas: true, drag: false },
      ...drag(4000, 4100, 8, false),
    ];
    const all = gestures(inputs, toTrace);
    const at = (from: number, to: number) =>
      describeActivity(inputs, all, toTrace, us(from), us(to));
    expect(at(500, 600)).toBe("pointer drag on canvas");
    expect(at(1600, 1700)).toBe("key press");
    expect(at(2050, 2100)).toBe("wheel on canvas");
    expect(at(3050, 3100)).toBe("pointer hover");
    expect(at(4000, 4050)).toBe("click on UI");
    expect(at(6000, 6100)).toBe("no input (background work)");
  });

  it("reads the tool at a time from the log of changes", () => {
    const tools = [
      { time: 100, tool: "Paintbrush" },
      { time: 500, tool: "Rectangle Select" },
    ];
    expect(toolAt(tools, 50)).toBeUndefined();
    expect(toolAt(tools, 100)).toBe("Paintbrush");
    expect(toolAt(tools, 499)).toBe("Paintbrush");
    expect(toolAt(tools, 900)).toBe("Rectangle Select");
  });
});

describe("analyze", () => {
  // Page time 0 is the clock mark. A drag from 1000 to 1400 ms with the Paintbrush; the main
  // thread runs one 120 ms task at 1100 ms, sampled every 1 ms: 80 ms renderStroke (under
  // onPointer), then 40 ms commitRoot. The engine presents every 16 ms except during the task.
  const samples = [
    ...Array.from({ length: 50 }, () => "(idle)"),
    ...Array.from({ length: 80 }, () => "renderStroke"),
    ...Array.from({ length: 40 }, () => "commitRoot"),
    ...Array.from({ length: 50 }, () => "(idle)"),
  ];
  const events = [
    threadName(MAIN, "CrRendererMain"),
    threadName(ENGINE, "DedicatedWorker thread"),
    clockMark(0),
    presentMeasure(10),
    task(MAIN, 900, 10),
    task(MAIN, 1100, 120),
    task(ENGINE, 2000, 30),
    ...profile(MAIN, "0x1", 1050, 1, FRAMES, samples),
    ...profile(ENGINE, "0x2", 1050, 1, FRAMES, ["(idle)", "commitRoot", "(idle)"]),
  ];
  const app = emptyApp({
    inputs: drag(1000, 1400),
    presents: [...presents(1000, 1100), ...presents(1230, 1500)],
    longFrames: [
      { start: 1095, duration: 130, blockingDuration: 80 },
      { start: 3000, duration: 40 },
    ],
    tools: [{ time: 10, tool: "Paintbrush" }],
  });

  it("reports one incident for the overlapping signals, with what ran and what the user did", () => {
    const analysis = analyze(events, app);
    expect(analysis.clockAligned).toBe(true);
    expect(analysis.threads).toEqual({ main: MAIN, engine: ENGINE });
    expect(analysis.profiled).toEqual({ main: true, engine: true });
    expect(analysis.taskSummary).toEqual([
      { thread: "main", longTasks: 1, longTaskMs: 120, longestTaskMs: 120, blockingMs: 70 },
      { thread: "engine", longTasks: 0, longTaskMs: 0, longestTaskMs: 0, blockingMs: 0 },
    ]);
    expect(analysis.spikeCounts).toEqual({ task: 1, frame: 1, "present-gap": 1, latency: 1 });
    expect(analysis.incidents).toHaveLength(1);
    const [incident] = analysis.incidents;
    expect(incident?.thread).toBe("main");
    expect(incident?.durationMs).toBe(130);
    expect(incident?.activity).toBe("pointer drag on canvas");
    expect(incident?.tool).toBe("Paintbrush");
    const main = incident?.threads.find((t) => t.thread === "main");
    expect(main?.busyMs).toBeCloseTo(120);
    expect(main?.self.map((f) => [f.name, Math.round(f.ms)])).toEqual([
      ["renderStroke", 80],
      ["commitRoot", 40],
    ]);
    expect(main?.inclusive.map((f) => [f.name, Math.round(f.ms)])).toEqual([
      ["onPointer", 80],
      ["renderStroke", 80],
      ["commitRoot", 40],
    ]);
    expect(analysis.hot[0]?.self[0]?.name).toBe("renderStroke");
  });

  it("clips samples to the attribution window", () => {
    // Only the frame's window: a task-free app with one long frame over 40 ms of renderStroke.
    const analysis = analyze(
      [clockMark(0), ...profile(MAIN, "0x1", 1050, 1, FRAMES, samples)],
      emptyApp({ longFrames: [{ start: 1150, duration: 60 }] }),
    );
    const main = analysis.incidents[0]?.threads[0];
    expect(analysis.incidents[0]?.activity).toBe("no input (background work)");
    expect(main?.self.map((f) => [f.name, Math.round(f.ms)])).toEqual([
      ["renderStroke", 30],
      ["commitRoot", 30],
    ]);
  });

  it("reports trace tasks alone when the app's clock cannot be lined up", () => {
    const analysis = analyze(
      [task(MAIN, 0, 80), threadName(MAIN, "CrRendererMain")],
      emptyApp({ clockTime: undefined }),
    );
    expect(analysis.clockAligned).toBe(false);
    expect(analysis.incidents.map((i) => [i.durationMs, i.activity])).toEqual([
      [80, "unknown (no app data)"],
    ]);
  });

  it("calls lag before the app was ready app loading", () => {
    const analysis = analyze([clockMark(500), task(MAIN, 100, 200)], emptyApp({ clockTime: 500 }));
    expect(analysis.incidents[0]?.activity).toBe("app loading");
    const ready = analyze(
      [clockMark(0), task(MAIN, 100, 200), task(MAIN, 900, 60)],
      emptyApp({ readyTime: 800 }),
    );
    expect(ready.incidents.map((incident) => incident.activity)).toEqual([
      "app loading",
      "no input (background work)",
    ]);
  });
});
