import type { Document, TileCoord, TiledPixelStore } from "@openpaint/document";
import { DocumentMirror, type EngineHandle } from "@openpaint/engine";
import { measured } from "./perf/user-timing";

/** The tile bytes one sync copies at most while a full sync is sent in slices: 64 tiles. */
const SYNC_SLICE_BYTES = 16 * 1024 * 1024;

/** Bindings that still have slices of a full sync to send. */
let slicing = 0;

/** Whether a full sync is still being sent in slices, for the perf harness's idle check. */
export function engineSyncPending(): boolean {
  return slicing > 0;
}

/** The mirror of each document bound to the engine, for `acknowledgeEngineTiles`. */
const mirrors = new WeakMap<Document, DocumentMirror>();

/**
 * Shows `doc` on the engine canvas and keeps it there (M2 binding). The engine is synced on every
 * document change. Live previews (tool strokes, effect and adjustment previews) notify the document
 * as they write, so they reach the canvas the same way. Syncs are incremental (a stack change sends
 * no tiles, an edit only the changed part of each tile), and engine v2 asks for a full sync after
 * it lost its GPU document. Returns the unbind function.
 */
export function bindEngineDocument(engine: EngineHandle, doc: Document | undefined): () => void {
  const mirror = new DocumentMirror();
  if (doc) mirrors.set(doc, mirror);
  let bound = true;
  let continuing = false;
  // A full sync (a newly opened image) goes out in slices of about SYNC_SLICE_BYTES, one per task,
  // so its copies never make one long task (L9, L10). A message, not a timer: nested timers wait.
  const channel = new MessageChannel();
  const setContinuing = (next: boolean) => {
    if (next !== continuing) slicing += next ? 1 : -1;
    continuing = next;
  };
  channel.port1.onmessage = () => {
    setContinuing(false);
    if (bound && mirror.pending) push();
  };
  const push = () => {
    measured("engine sync", () => void engine.syncDocument(mirror.describe(doc, SYNC_SLICE_BYTES)));
    if (mirror.pending && !continuing) {
      setContinuing(true);
      channel.port2.postMessage(undefined);
    }
  };
  push();
  // The selection is drawn over the canvas by the app, so a selection preview sends nothing.
  const unsubscribe = doc?.subscribe((change) => {
    if (change !== "selection") push();
  });
  const unresync = engine.onResync(() => {
    mirror.invalidate();
    push();
  });
  return () => {
    bound = false;
    setContinuing(false);
    channel.port1.close();
    unsubscribe?.();
    unresync();
    if (doc && mirrors.get(doc) === mirror) mirrors.delete(doc);
  };
}

/**
 * Tells the binding that the engine already holds `tiles` of `store`, such as a v2 stroke it
 * painted and read back, so the next sync does not send them back to it.
 */
export function acknowledgeEngineTiles(
  doc: Document,
  store: TiledPixelStore,
  tiles: readonly TileCoord[],
): void {
  mirrors.get(doc)?.acknowledge(store, tiles);
}
