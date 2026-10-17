import initWasm from "@openpaint/cpu";
import { decodeSpill, encodeSpill } from "@openpaint/document";
import type { SpillReply, SpillWorkerJob } from "./spill-processor";

// The app compiles against the DOM lib, so the dedicated worker scope is typed structurally.
interface WorkerScope {
  onmessage: ((event: MessageEvent<SpillWorkerJob>) => void) | null;
  postMessage(message: SpillReply, transfer: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;
const wasmReady = initWasm();

scope.onmessage = (event) => {
  const job = event.data;
  wasmReady
    .then(() => run(job))
    .then((data) => {
      scope.postMessage({ id: job.id, ok: true, data }, [data.buffer]);
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

function run(job: SpillWorkerJob): Uint8Array<ArrayBuffer> {
  const data = job.op === "encode" ? encodeSpill(job.raw, job.codec) : decodeSpill(job.encoded);
  return data as Uint8Array<ArrayBuffer>;
}
