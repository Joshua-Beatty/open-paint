import { type CodecJob, ensureCodecWasm, executeCodecJob } from "./codec-jobs";

// The package compiles against the DOM lib, so the dedicated worker scope is typed structurally.
interface WorkerScope {
  onmessage:
    | ((event: MessageEvent<{ readonly id: number; readonly job: CodecJob }>) => void)
    | null;
  postMessage(message: unknown): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.onmessage = (event) => {
  const { id, job } = event.data;
  ensureCodecWasm()
    .then(() => executeCodecJob(job))
    .then(
      (result) => scope.postMessage({ id, ok: true, result }),
      (error: unknown) =>
        scope.postMessage({
          id,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }),
    );
};
