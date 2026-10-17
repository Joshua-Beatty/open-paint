import initWasm from "@openpaint/cpu";
import {
  builtinEffectBindings,
  type CpuJob,
  type CpuReply,
  type EffectBinding,
  ownedPixels,
  runCpuJobOutputs,
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
      const [output, ...rest] = runCpuJobOutputs(job, bindings);
      if (output === undefined) throw new Error("The job had no output.");
      const pixels = ownedPixels(output);
      const more = rest.map((surface) => ({
        width: surface.width,
        height: surface.height,
        pixels: ownedPixels(surface),
      }));
      scope.postMessage(
        {
          id: job.id,
          ok: true,
          width: output.width,
          height: output.height,
          pixels,
          ...(more.length > 0 && { more }),
        },
        [pixels.buffer, ...more.map((item) => item.pixels.buffer)],
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
