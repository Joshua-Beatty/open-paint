import { BufferUsage, TextureUsage } from "./gpu-device";

/** GPU performance class (SET-DLG-07, ARC-02-04). */
export type PerformanceClass = "VeryLow" | "Low" | "Good";

/** Edge of the square benchmark texture (SET-DLG-07 proposal). */
export const BENCHMARK_SIZE = 1024;
/** Timed blur passes after one untimed warm-up pass. */
export const BENCHMARK_PASSES = 8;
/** Adapters finishing the timed passes within this budget (one 60 Hz frame) are "Good". */
export const GOOD_BUDGET_MS = 16;

export function classifyBenchmark(elapsedMs: number): PerformanceClass {
  return elapsedMs <= GOOD_BUDGET_MS ? "Good" : "Low";
}

const BLUR_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(textureDimensions(src));
  let p = vec2i(id.xy);
  if (p.x >= size.x || p.y >= size.y) { return; }
  var sum = vec4f(0.0);
  for (var dy = -4; dy <= 4; dy++) {
    for (var dx = -4; dx <= 4; dx++) {
      sum += textureLoad(src, clamp(p + vec2i(dx, dy), vec2i(0), size - 1), 0);
    }
  }
  textureStore(dst, p, sum / 81.0);
}
`;

/**
 * The GPU time of `BENCHMARK_PASSES` passes from wall-clock timings of runs: a run's time includes
 * the browser's round trip to report the work done, which is far longer in some browsers (Firefox)
 * than the work itself. Twice the passes cost twice the work but the same round trip, so the
 * difference of the fastest runs of each length is the work alone.
 */
export function gpuTimeOf(single: readonly number[], double: readonly number[]): number {
  return Math.max(0, Math.min(...double) - Math.min(...single));
}

/** Timed runs of each length; the fastest of each counts. */
const BENCHMARK_RUNS = 3;

/**
 * Times a fixed 9x9 box blur ping-ponged over a 1024x1024 texture and classifies the device as
 * Low or Good. VeryLow (CPU backend, fallback adapters) is decided without benchmarking. The GPU's
 * own timestamps are used when the device has them; otherwise `gpuTimeOf` takes the browser's
 * reporting delay out of the wall-clock time.
 */
export async function benchmarkPerformanceClass(device: GPUDevice): Promise<PerformanceClass> {
  const textures = [0, 1].map(() =>
    device.createTexture({
      size: [BENCHMARK_SIZE, BENCHMARK_SIZE],
      format: "rgba8unorm",
      usage: TextureUsage.TEXTURE_BINDING | TextureUsage.STORAGE_BINDING,
    }),
  ) as [GPUTexture, GPUTexture];
  try {
    const pipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module: device.createShaderModule({ code: BLUR_WGSL }), entryPoint: "main" },
    });
    const [a, b] = textures;
    const bindGroups = [
      [a, b],
      [b, a],
    ].map(([src, dst]) =>
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: (src as GPUTexture).createView() },
          { binding: 1, resource: (dst as GPUTexture).createView() },
        ],
      }),
    );
    const groups = Math.ceil(BENCHMARK_SIZE / 8);
    const timestamps = device.features.has("timestamp-query")
      ? {
          set: device.createQuerySet({ type: "timestamp", count: 2 }),
          resolve: device.createBuffer({ size: 16, usage: QUERY_RESOLVE | BufferUsage.COPY_SRC }),
          read: device.createBuffer({
            size: 16,
            usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
          }),
        }
      : undefined;
    /** Runs `passes` passes; resolves with the GPU's own nanoseconds when it has timestamps. */
    const run = async (passes: number): Promise<number | undefined> => {
      const encoder = device.createCommandEncoder();
      for (let i = 0; i < passes; i++) {
        // A pass's timestamp writes must name at least one index: only the first and last do.
        const writes =
          timestamps === undefined || (i !== 0 && i !== passes - 1)
            ? undefined
            : {
                querySet: timestamps.set,
                ...(i === 0 && { beginningOfPassWriteIndex: 0 }),
                ...(i === passes - 1 && { endOfPassWriteIndex: 1 }),
              };
        const pass = encoder.beginComputePass(writes ? { timestampWrites: writes } : {});
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroups[i % 2] as GPUBindGroup);
        pass.dispatchWorkgroups(groups, groups);
        pass.end();
      }
      if (timestamps === undefined) {
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        return undefined;
      }
      encoder.resolveQuerySet(timestamps.set, 0, 2, timestamps.resolve, 0);
      encoder.copyBufferToBuffer(timestamps.resolve, 0, timestamps.read, 0, 16);
      device.queue.submit([encoder.finish()]);
      await timestamps.read.mapAsync(MAP_READ_MODE);
      const [begin = 0n, end = 0n] = new BigUint64Array(timestamps.read.getMappedRange().slice(0));
      timestamps.read.unmap();
      return Number(end - begin);
    };
    try {
      await run(1);
      const nanoseconds = await run(BENCHMARK_PASSES);
      // Some implementations report zeros (timestamps off or quantized away): time the runs then.
      if (nanoseconds !== undefined && nanoseconds > 0) {
        return classifyBenchmark(nanoseconds / 1e6);
      }
      const timed = async (passes: number) => {
        const start = performance.now();
        await run(passes);
        return performance.now() - start;
      };
      const single: number[] = [];
      const double: number[] = [];
      for (let i = 0; i < BENCHMARK_RUNS; i++) {
        single.push(await timed(BENCHMARK_PASSES));
        double.push(await timed(2 * BENCHMARK_PASSES));
      }
      return classifyBenchmark(gpuTimeOf(single, double));
    } finally {
      timestamps?.set.destroy();
      timestamps?.resolve.destroy();
      timestamps?.read.destroy();
    }
  } finally {
    for (const texture of textures) texture.destroy();
  }
}

/** `GPUBufferUsage.QUERY_RESOLVE`. */
const QUERY_RESOLVE = 0x200;
/** `GPUMapMode.READ`. */
const MAP_READ_MODE = 1;
