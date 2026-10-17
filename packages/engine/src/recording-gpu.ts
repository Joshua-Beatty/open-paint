/**
 * A WebGPU device for unit tests of the compute runners, without a GPU: every call is accepted and
 * nothing is computed (readbacks are zeros). It counts submissions, readbacks and buffers, and
 * error scopes answer when the test says so (`answerScopes`).
 */
export function recordingDevice() {
  const counts = { submits: 0, maps: 0, alive: 0, created: 0, mapReadCreated: 0 };
  const scopes: { resolve: (error: GPUError | null) => void }[] = [];
  let scopeError: GPUError | null = null;
  const buffer = (size: number, usage: number) => {
    counts.alive += 1;
    counts.created += 1;
    if ((usage & 0x1) !== 0) counts.mapReadCreated += 1;
    return {
      size,
      usage,
      mapAsync: async () => {
        counts.maps += 1;
      },
      getMappedRange: (_offset = 0, length = size) => new ArrayBuffer(length),
      unmap: () => undefined,
      destroy: () => {
        counts.alive -= 1;
      },
    };
  };
  const pass = {
    setPipeline: () => undefined,
    setBindGroup: () => undefined,
    dispatchWorkgroups: () => undefined,
    end: () => undefined,
  };
  const device = {
    limits: { maxStorageBufferBindingSize: 2 ** 30, maxBufferSize: 2 ** 31 },
    createShaderModule: () => ({}),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBuffer: ({ size, usage }: { size: number; usage: number }) => buffer(size, usage),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({
      beginComputePass: () => pass,
      copyBufferToBuffer: () => undefined,
      finish: () => ({}),
    }),
    pushErrorScope: () => undefined,
    popErrorScope: () =>
      new Promise<GPUError | null>((resolve) => {
        scopes.push({ resolve });
      }),
    queue: {
      writeBuffer: () => undefined,
      submit: () => {
        counts.submits += 1;
      },
    },
  };
  return {
    device: device as unknown as GPUDevice,
    counts,
    /** Error scopes popped and not answered yet. */
    get waitingScopes() {
      return scopes.length;
    },
    /** Answers the scopes popped so far: with `error` for the first of each pair, then none. */
    answerScopes(error: GPUError | null = scopeError): void {
      scopeError = null;
      for (const [index, scope] of scopes.splice(0).entries()) {
        scope.resolve(index % 2 === 0 ? error : null);
      }
    },
  };
}
