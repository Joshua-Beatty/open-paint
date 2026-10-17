import { Surface } from "@openpaint/document";
import type { EffectBinding } from "@openpaint/effects";
import { describe, expect, it, vi } from "vitest";
import {
  GPU_SOURCE_MISSING,
  type GpuEffectJob,
  type GpuEffectOutput,
  TRANSFORM_JOB,
} from "./gpu-effect-protocol";
import { EngineGpuOffloader, type GpuEffectPort } from "./gpu-effects-client";

function binding(id: string): EffectBinding<unknown> {
  return {
    descriptor: { id } as EffectBinding["descriptor"],
    params: () => ({}),
    cpu: (input) => input,
  };
}

const BLUR = binding("gaussian-blur");

/** A port that answers each run with the pixels inverted, or as `answer` says. */
function port(answer?: (job: GpuEffectJob) => Promise<GpuEffectOutput>) {
  const jobs: GpuEffectJob[] = [];
  const fake = {
    effectRun: vi.fn((job: GpuEffectJob) => {
      jobs.push(job);
      if (answer) return answer(job);
      const pixels = new Uint8ClampedArray(job.width * job.height * 4).fill(9);
      return Promise.resolve({ width: job.width, height: job.height, pixels });
    }),
    effectCancel: vi.fn(() => Promise.resolve()),
    effectRelease: vi.fn(() => Promise.resolve()),
  } satisfies GpuEffectPort;
  return { fake, jobs };
}

describe("EngineGpuOffloader", () => {
  it("runs only effects with a GPU runner, and only while the engine is on WebGPU", () => {
    let webgpu = true;
    const offloader = new EngineGpuOffloader(port().fake, () => webgpu);
    expect(offloader.canRun(BLUR)).toBe(true);
    expect(offloader.canRun(binding("quantize"))).toBe(false);
    webgpu = false;
    expect(offloader.canRun(BLUR)).toBe(false);
  });

  it("sends a session's source once, then only the parameters", async () => {
    const { fake, jobs } = port();
    const offloader = new EngineGpuOffloader(fake, () => true);
    const input = new Surface(2, 2);
    const coverage = new Uint8Array([255, 0, 255, 0]);
    const signal = new AbortController().signal;
    const out = await offloader.run(BLUR, input, { radius: 1 }, coverage, signal);
    await offloader.run(BLUR, input, { radius: 2 }, coverage, signal);
    expect(out.data[0]).toBe(9);
    expect(jobs[0]?.pixels?.length).toBe(16);
    expect([...(jobs[0]?.coverage ?? [])]).toEqual([255, 0, 255, 0]);
    expect(jobs[1]?.pixels).toBeUndefined();
    expect(jobs[1]?.source).toBe(jobs[0]?.source);
    offloader.release(input);
    expect(fake.effectRelease).toHaveBeenCalledWith(jobs[0]?.source);
  });

  it("rejects a canceled run at once and tells the worker to drop it", async () => {
    const { fake } = port(() => new Promise(() => undefined));
    const offloader = new EngineGpuOffloader(fake, () => true);
    const controller = new AbortController();
    const run = offloader.run(BLUR, new Surface(1, 1), {}, undefined, controller.signal);
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.effectCancel).toHaveBeenCalledWith(1);
    // A cancel is not a failure: the effect still runs on the GPU next time.
    expect(offloader.canRun(BLUR)).toBe(true);
  });

  it("sends the source again when the worker no longer holds it", async () => {
    let calls = 0;
    const { fake, jobs } = port(() => {
      calls += 1;
      if (calls === 2) {
        const error = new Error("missing");
        error.name = GPU_SOURCE_MISSING;
        return Promise.reject(error);
      }
      return Promise.resolve({ width: 1, height: 1, pixels: new Uint8ClampedArray(4) });
    });
    const offloader = new EngineGpuOffloader(fake, () => true);
    const input = new Surface(1, 1);
    const signal = new AbortController().signal;
    await offloader.run(BLUR, input, {}, undefined, signal);
    await offloader.run(BLUR, input, {}, undefined, signal);
    expect(jobs.map((job) => job.pixels !== undefined)).toEqual([true, false, true]);
  });

  it("stops trying an effect on the GPU after it failed there", async () => {
    const { fake } = port(() => Promise.reject(new Error("validation")));
    const offloader = new EngineGpuOffloader(fake, () => true);
    await expect(
      offloader.run(BLUR, new Surface(1, 1), {}, undefined, new AbortController().signal),
    ).rejects.toThrow("validation");
    expect(offloader.canRun(BLUR)).toBe(false);
  });
  it("resamples Move Selected Pixels content as a tool job, sending the content once", async () => {
    const { fake, jobs } = port();
    const offloader = new EngineGpuOffloader(fake, () => true);
    const content = new Surface(3, 2);
    const spec = {
      width: 4,
      height: 4,
      inverse: [1, 0, 0, 1, 0, 0],
      sampling: 4,
      linearLight: true,
    };
    const signal = new AbortController().signal;
    await offloader.transform(content, spec, signal);
    await offloader.transform(content, { ...spec, width: 5 }, signal);
    expect(jobs.map((job) => [job.effectId, job.pixels?.length])).toEqual([
      [TRANSFORM_JOB, 24],
      [TRANSFORM_JOB, undefined],
    ]);
    expect(offloader.canTransform).toBe(true);
  });
});
