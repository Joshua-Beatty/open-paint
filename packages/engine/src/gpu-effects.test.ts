import { builtinEffectBindings } from "@openpaint/effects";
import { describe, expect, it } from "vitest";
import { GPU_EFFECT_IDS, GPU_SOURCE_MISSING, type GpuEffectJob } from "./gpu-effect-protocol";
import { GPU_RUNNER_IDS, GpuEffectError, GpuEffectQueue } from "./gpu-effects";

function job(id: number, source: number, withPixels: boolean): GpuEffectJob {
  return {
    id,
    effectId: "gaussian-blur",
    params: { radius: 2, gammaBoost: 0, quality: 4 },
    source,
    width: 2,
    height: 1,
    ...(withPixels && { pixels: new Uint8ClampedArray(8) }),
  };
}

describe("GPU effect ids", () => {
  it("lists exactly the effects of the worker's runner table", () => {
    expect([...GPU_EFFECT_IDS].sort()).toEqual([...GPU_RUNNER_IDS].sort());
  });

  it("covers every built-in effect except those without a usable WGSL twin", () => {
    const builtins = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    for (const id of GPU_EFFECT_IDS) expect(builtins).toContain(id);
    expect(builtins.filter((id) => !GPU_EFFECT_IDS.has(id)).sort()).toEqual(["quantize"]);
  });
});

describe("GpuEffectQueue", () => {
  it("rejects with a GPU error when the engine has no device, so the caller uses the CPU", async () => {
    const queue = new GpuEffectQueue(() => undefined);
    await expect(queue.run(job(1, 1, true))).rejects.toBeInstanceOf(GpuEffectError);
    expect(queue.busy).toBe(false);
  });

  it("asks for the source again when it does not hold it", async () => {
    const queue = new GpuEffectQueue(() => undefined);
    await expect(queue.run(job(1, 7, false))).rejects.toMatchObject({ name: GPU_SOURCE_MISSING });
  });

  it("never starts a job canceled while it waits", async () => {
    const queue = new GpuEffectQueue(() => undefined);
    const first = queue.run(job(1, 1, true));
    const second = queue.run(job(2, 1, false));
    queue.cancel(2);
    await expect(first).rejects.toBeInstanceOf(GpuEffectError);
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps only the newest sources and forgets released ones", async () => {
    const queue = new GpuEffectQueue(() => undefined, 2);
    for (const source of [1, 2, 3]) {
      await queue.run(job(source, source, true)).catch(() => undefined);
    }
    await expect(queue.run(job(4, 1, false))).rejects.toMatchObject({ name: GPU_SOURCE_MISSING });
    await expect(queue.run(job(5, 3, false))).rejects.toBeInstanceOf(GpuEffectError);
    queue.release(3);
    await expect(queue.run(job(6, 3, false))).rejects.toMatchObject({ name: GPU_SOURCE_MISSING });
  });
});
