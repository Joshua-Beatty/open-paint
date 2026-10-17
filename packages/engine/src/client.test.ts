import { describe, expect, it, vi } from "vitest";
import { connectEngine, DEFAULT_ENGINE_SETTINGS } from "./client";
import type { EnginePerfReport } from "./perf";
import type { EngineProtocol, EngineStatus } from "./protocol";
import { type RpcEndpoint, serveRpc } from "./rpc";

/** Two endpoints that deliver messages asynchronously without cloning, recording transfers. */
function loopback() {
  const transfers: Transferable[][] = [];
  const make = () => {
    const listeners = new Set<(event: MessageEvent) => void>();
    const endpoint = {
      peer: undefined as unknown as { listeners: typeof listeners },
      listeners,
      terminated: false,
      postMessage(data: unknown, transfer: Transferable[]) {
        transfers.push(transfer);
        queueMicrotask(() => {
          for (const l of endpoint.peer.listeners) l({ data } as MessageEvent);
        });
      },
      addEventListener: (_: "message", l: (event: MessageEvent) => void) => listeners.add(l),
      removeEventListener: (_: "message", l: (event: MessageEvent) => void) => listeners.delete(l),
      terminate() {
        endpoint.terminated = true;
      },
    };
    return endpoint;
  };
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return { client: a, worker: b as RpcEndpoint, transfers };
}

const status: EngineStatus = {
  ...DEFAULT_ENGINE_SETTINGS,
  setting: "Automatic",
  backend: "webgpu",
  reason: "chosen",
  webgpuAvailable: true,
  performanceClass: "Good",
  deviceLossCount: 0,
};

const idleReport: EnginePerfReport = { timeOrigin: 0, presents: [], idle: true };

/** Engine v2 stroke handlers that a v1 fake never receives. */
const NO_STROKES = {
  strokeBegin: () => undefined,
  strokeSamples: () => undefined,
  strokeEnd: () => undefined,
  strokeCancel: () => undefined,
  effectRun: () => {
    throw new Error("no GPU");
  },
  effectCancel: () => undefined,
  effectRelease: () => undefined,
};

describe("connectEngine", () => {
  it("passes view layouts to listeners, replaying the latest one to late listeners", async () => {
    const { client, worker } = loopback();
    const canvas = { kind: "offscreen" } as unknown as OffscreenCanvas;
    const server = serveRpc<EngineProtocol>(worker, {
      init: () => status,
      setBackend: () => status,
      resize: () => undefined,
      loadTestDocument: () => undefined,
      syncDocument: () => undefined,
      view: () => ({ mode: "fit", zoom: 1 }),
      wheel: () => ({ mode: "fit", zoom: 1 }),
      tick: () => undefined,
      setCanvasStyle: () => undefined,
      setVisible: () => undefined,
      perf: () => idleReport,
      ...NO_STROKES,
    });
    const engine = await connectEngine(client, {
      ...DEFAULT_ENGINE_SETTINGS,
      canvas,
      width: 640,
      height: 480,
      scale: 1,
    });
    const layout = {
      mode: "fixed",
      zoom: 2,
      originX: -10,
      originY: 0,
      documentWidth: 300,
      documentHeight: 200,
    } as const;
    const seen: unknown[] = [];
    engine.onLayout((next) => seen.push(next));
    server.emit("view", layout);
    await vi.waitFor(() => expect(seen).toEqual([layout]));

    const late: unknown[] = [];
    engine.onLayout((next) => late.push(next));
    expect(late).toEqual([layout]);
    server.emit("view", { ...layout, zoom: 4 });
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ zoom: 4 }));
    expect(late.at(-1)).toMatchObject({ zoom: 4 });
    engine.terminate();
  });

  it("transfers the canvas, tracks status events and forwards requests", async () => {
    const { client, worker, transfers } = loopback();
    const canvas = { kind: "offscreen" } as unknown as OffscreenCanvas;
    const resized: unknown[] = [];
    const loaded: unknown[] = [];
    let ticks = 0;
    const visibility: boolean[] = [];
    const server = serveRpc<EngineProtocol>(worker, {
      init: (init) => ({ ...status, setting: init.backend }),
      setBackend: (setting) => ({ ...status, setting, backend: "cpu", reason: "turned-off" }),
      resize: (size) => {
        resized.push(size);
        return undefined;
      },
      syncDocument: () => undefined,
      loadTestDocument: (size) => {
        loaded.push(size);
        return undefined;
      },
      view: () => ({ mode: "fit", zoom: 0.5 }),
      wheel: () => ({ mode: "fixed", zoom: 2 }),
      tick: () => {
        ticks++;
        return undefined;
      },
      setCanvasStyle: () => undefined,
      setVisible: (visible) => {
        visibility.push(visible);
        return undefined;
      },
      perf: () => ({ ...idleReport, presents: [1, 2] }),
      ...NO_STROKES,
    });

    const engine = await connectEngine(client, {
      ...DEFAULT_ENGINE_SETTINGS,
      canvas,
      width: 640,
      height: 480,
      scale: 2,
    });
    expect(transfers[0]).toEqual([canvas]);
    expect(engine.status.backend).toBe("webgpu");

    const seen: EngineStatus[] = [];
    engine.onStatus((s) => seen.push(s));
    const lost = { ...status, backend: "cpu", reason: "device-loss", errorFlags: 1 } as const;
    server.emit("status", lost);
    await engine.resize({ width: 320, height: 200, scale: 1 });
    expect(resized).toEqual([{ width: 320, height: 200, scale: 1 }]);
    await engine.loadTestDocument(8192, 8192);
    expect(loaded).toEqual([{ width: 8192, height: 8192 }]);
    expect(await engine.view({ type: "fit" })).toEqual({ mode: "fit", zoom: 0.5 });
    expect(
      await engine.wheel({
        x: 1,
        y: 2,
        deltaX: 0,
        deltaY: -100,
        deltaMode: 0,
        ctrlKey: true,
        shiftKey: false,
      }),
    ).toEqual({ mode: "fixed", zoom: 2 });
    expect(engine.status).toEqual(lost);

    expect(await engine.setBackend("Cpu")).toMatchObject({ setting: "Cpu", backend: "cpu" });
    expect(seen.map((s) => s.reason)).toEqual(["device-loss", "turned-off"]);

    await engine.setVisible(false);
    await engine.setVisible(true);
    expect(visibility).toEqual([false, true]);
    expect(ticks).toBe(0);

    expect(await engine.perf()).toEqual({ ...idleReport, presents: [1, 2] });
    const batches: EnginePerfReport[] = [];
    const detach = engine.onPerf((report) => batches.push(report));
    server.emit("perf", { ...idleReport, presents: [3, 4] });
    await vi.waitFor(() => expect(batches.map((b) => b.presents)).toEqual([[3, 4]]));
    detach();

    engine.terminate();
    expect(client.terminated).toBe(true);
  });

  it("answers worker frame requests with a tick at the next animation frame", async () => {
    const { client, worker } = loopback();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    let ticks = 0;
    const server = serveRpc<EngineProtocol>(worker, {
      init: () => status,
      setBackend: () => status,
      resize: () => undefined,
      loadTestDocument: () => undefined,
      syncDocument: () => undefined,
      view: () => ({ mode: "fit", zoom: 1 }),
      wheel: () => ({ mode: "fit", zoom: 1 }),
      tick: () => {
        ticks++;
        return undefined;
      },
      setCanvasStyle: () => undefined,
      setVisible: () => undefined,
      perf: () => idleReport,
      ...NO_STROKES,
    });
    try {
      await connectEngine(client, {
        ...DEFAULT_ENGINE_SETTINGS,
        canvas: {} as OffscreenCanvas,
        width: 1,
        height: 1,
        scale: 1,
      });
      server.emit("frame", undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(frames).toHaveLength(1);
      expect(ticks).toBe(0);
      frames[0]?.(0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(ticks).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("passes worker errors to the page, keeping those from before the first listener", async () => {
    const { client, worker } = loopback();
    let server: ReturnType<typeof serveRpc<EngineProtocol>> | undefined;
    server = serveRpc<EngineProtocol>(worker, {
      init: () => {
        // Reported while starting, before the page can listen.
        server?.emit("error", { name: "Error", message: "presenter failed" });
        return status;
      },
      setBackend: () => status,
      resize: () => undefined,
      loadTestDocument: () => undefined,
      syncDocument: () => undefined,
      view: () => ({ mode: "fit", zoom: 1 }),
      wheel: () => ({ mode: "fit", zoom: 1 }),
      tick: () => undefined,
      setCanvasStyle: () => undefined,
      setVisible: () => undefined,
      perf: () => idleReport,
      ...NO_STROKES,
    });
    const engine = await connectEngine(client, {
      ...DEFAULT_ENGINE_SETTINGS,
      canvas: {} as OffscreenCanvas,
      width: 1,
      height: 1,
      scale: 1,
    });
    const seen: string[] = [];
    engine.onError((error) => seen.push(error.message));
    expect(seen).toEqual(["presenter failed"]);
    server.emit("error", { name: "Error", message: "uncaptured" });
    await vi.waitFor(() => expect(seen).toEqual(["presenter failed", "uncaptured"]));
    engine.terminate();
  });

  it("terminates the worker when initialization fails", async () => {
    const { client, worker } = loopback();
    serveRpc<EngineProtocol>(worker, {
      init: () => {
        throw new Error("The canvas cannot present bitmaps.");
      },
      setBackend: () => status,
      resize: () => undefined,
      loadTestDocument: () => undefined,
      syncDocument: () => undefined,
      view: () => ({ mode: "fit", zoom: 1 }),
      wheel: () => ({ mode: "fit", zoom: 1 }),
      tick: () => undefined,
      setCanvasStyle: () => undefined,
      setVisible: () => undefined,
      perf: () => idleReport,
      ...NO_STROKES,
    });
    await expect(
      connectEngine(client, {
        ...DEFAULT_ENGINE_SETTINGS,
        canvas: {} as OffscreenCanvas,
        width: 1,
        height: 1,
        scale: 1,
      }),
    ).rejects.toThrow("cannot present bitmaps");
    expect(client.terminated).toBe(true);
  });
});
