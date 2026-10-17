import initWasm from "@openpaint/cpu";
import {
  builtinEffectBindings,
  type CpuJob,
  type CpuReply,
  type EffectBinding,
  runCpuJob,
} from "@openpaint/effects";

// The app compiles against the DOM lib, so the dedicated worker scope is typed structurally.
interface WorkerScope {
  onmessage: ((event: MessageEvent<{ readonly job: CpuJob }>) => void) | null;
  postMessage(message: CpuReply, transfer: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;

// The quality levels only shape the parameters, which the main thread has already resolved, so
// any levels give the same CPU implementations.
const bindings = builtinEffectBindings(1, 1) as EffectBinding<unknown>[];
const wasmReady = initWasm();

scope.onmessage = (event) => {
  const { job } = event.data;
  wasmReady
    .then(() => {
      const output = runCpuJob(job, bindings);
      const data = output.data;
      const pixels =
        data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
      scope.postMessage(
        { id: job.id, ok: true, width: output.width, height: output.height, pixels },
        [pixels.buffer],
      );
    })
    .catch((error: unknown) => {
      scope.postMessage(
        {
          id: job.id,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        },
        [],
      );
    });
};
