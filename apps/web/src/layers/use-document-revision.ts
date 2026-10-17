import type { Document } from "@openpaint/document";
import { useEffect, useReducer } from "react";

/**
 * Re-renders the caller on every change of `doc` except live pixel and selection previews, and
 * returns a counter that changes with each one. Previews come once per frame during a stroke, a drag
 * or an effect preview and change nothing the shell shows (layer list, history, menus, title), so
 * re-rendering on them would only take the main thread away from input. Read the document directly
 * during render, since its layer list is mutated in place.
 */
export function useDocumentRevision(doc: Document | undefined): number {
  const [revision, bump] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (doc === undefined) return undefined;
    return doc.subscribe((change) => {
      if (change === "state") bump();
    });
  }, [doc]);
  return revision;
}
