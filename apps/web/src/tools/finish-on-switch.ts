import type { Document } from "@openpaint/document";

/**
 * Calls `finish` whenever another layer of `document` becomes active (TL-FRAME-01: switching layer
 * commits a pending result). The selection is document-wide, so it stays, but a pending result was
 * drawn on the layer that was active, and it is finished there. The next gesture starts on the new
 * layer. Returns the function that stops listening.
 */
export function finishOnLayerSwitch(document: Document, finish: () => void): () => void {
  let layer = document.activeLayer;
  return document.subscribe((change) => {
    if (change !== "state") return;
    const next = document.activeLayer;
    if (next === layer) return;
    layer = next;
    finish();
  });
}
