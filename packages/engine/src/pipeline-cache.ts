/** A compute shader's entry point: what one compute pipeline runs. */
export interface ComputeShader {
  readonly label: string;
  readonly code: string;
  readonly entryPoint: string;
}

type Entry = GPUComputePipeline | Promise<void>;

/** Each device's pipelines by shader, or the creation still running for them. */
const pipelines = new WeakMap<GPUDevice, Map<ComputeShader, Entry>>();

function entries(device: GPUDevice): Map<ComputeShader, Entry> {
  let map = pipelines.get(device);
  if (map === undefined) {
    map = new Map();
    pipelines.set(device, map);
  }
  return map;
}

function descriptor(device: GPUDevice, shader: ComputeShader): GPUComputePipelineDescriptor {
  const { label, code, entryPoint } = shader;
  return {
    label,
    layout: "auto",
    compute: { module: device.createShaderModule({ label, code }), entryPoint },
  };
}

/**
 * The compute pipeline that runs `shader` on `device`, created once per device and kept. When
 * `warmComputePipelines` has not finished it yet, it is created here at once.
 */
export function computePipeline(device: GPUDevice, shader: ComputeShader): GPUComputePipeline {
  const map = entries(device);
  const known = map.get(shader);
  if (known !== undefined && !(known instanceof Promise)) return known;
  const pipeline = device.createComputePipeline(descriptor(device, shader));
  map.set(shader, pipeline);
  return pipeline;
}

/** Whether `computePipeline` has `shader`'s pipeline on `device` ready. */
export function computePipelineReady(device: GPUDevice, shader: ComputeShader): boolean {
  const known = pipelines.get(device)?.get(shader);
  return known !== undefined && !(known instanceof Promise);
}

/**
 * Creates the pipelines of `shaders` on `device` in the background (`createComputePipelineAsync`),
 * so their shaders are compiled before their first use instead of during it. Resolves once all are
 * ready; a creation that fails is left to `computePipeline`, which reports its error on use.
 */
export function warmComputePipelines(
  device: GPUDevice,
  shaders: readonly ComputeShader[],
): Promise<void> {
  const map = entries(device);
  const pending: Promise<void>[] = [];
  for (const shader of shaders) {
    const known = map.get(shader);
    if (known instanceof Promise) pending.push(known);
    if (known !== undefined) continue;
    if (typeof device.createComputePipelineAsync !== "function") continue;
    const creating: Promise<void> = device
      .createComputePipelineAsync(descriptor(device, shader))
      .then(
        (pipeline) => {
          if (map.get(shader) === creating) map.set(shader, pipeline);
        },
        () => {
          if (map.get(shader) === creating) map.delete(shader);
        },
      );
    map.set(shader, creating);
    pending.push(creating);
  }
  return Promise.all(pending).then(() => undefined);
}
