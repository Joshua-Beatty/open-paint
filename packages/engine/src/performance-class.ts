import { TextureUsage } from "./gpu-device";

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
 * Times a fixed 9x9 box blur ping-ponged over a 1024x1024 texture and classifies the device as
 * Low or Good. VeryLow (CPU backend, fallback adapters) is decided without benchmarking.
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
    const run = async (passes: number) => {
      const encoder = device.createCommandEncoder();
      for (let i = 0; i < passes; i++) {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroups[i % 2] as GPUBindGroup);
        pass.dispatchWorkgroups(groups, groups);
        pass.end();
      }
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
    };
    await run(1);
    const start = performance.now();
    await run(BENCHMARK_PASSES);
    return classifyBenchmark(performance.now() - start);
  } finally {
    for (const texture of textures) texture.destroy();
  }
}
