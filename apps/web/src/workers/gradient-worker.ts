import initWasm from "@openpaint/cpu";
import {
  type GradientTileJob,
  type GradientTileReply,
  renderGradientTile,
} from "../tools/gradient-tiles";

// The app compiles against the DOM lib, so the dedicated worker scope is typed structurally.
interface WorkerScope {
  onmessage: ((event: MessageEvent<GradientTileJob>) => void) | null;
  postMessage(message: GradientTileReply, transfer: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;
const wasmReady = initWasm();

/** The base pixels and selection coverage of each tile, by session and tile, sent once per session. */
const cache = new Map<
  string,
  { base: Uint8ClampedArray<ArrayBuffer>; coverage: Uint8Array | undefined }
>();

scope.onmessage = (event) => {
  const job = event.data;
  if (job.kind === "end") {
    for (const key of [...cache.keys()]) {
      if (key.startsWith(`${job.session}:`)) cache.delete(key);
    }
    return;
  }
  const key = `${job.session}:${job.key}`;
  if (job.base !== undefined) cache.set(key, { base: job.base, coverage: job.coverage });
  wasmReady
    .then(() => {
      const tile = cache.get(key);
      if (tile === undefined) throw new Error("The tile's base pixels were never sent.");
      const pixels = renderGradientTile(job, tile.base, tile.coverage);
      scope.postMessage(
        { session: job.session, generation: job.generation, key: job.key, ok: true, pixels },
        [pixels.buffer],
      );
    })
    .catch((error: unknown) => {
      scope.postMessage(
        {
          session: job.session,
          generation: job.generation,
          key: job.key,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        },
        [],
      );
    });
};
