import { useEffect, useRef } from "react";

/** Work that runs at most once per animation frame, at its newest request. */
export interface FrameRequest {
  /** Runs `work` before the next repaint, replacing any request not yet run. */
  readonly request: (work: () => void) => void;
  /** Runs the pending work now, if any, for example when a drag ends. */
  readonly flush: () => void;
}

/**
 * Coalesces pointer-driven updates to one per frame (L1): a burst of pointer moves between two
 * frames commits only where the pointer ended up. Pending work is dropped on unmount.
 */
export function useFrameRequest(): FrameRequest {
  const state = useRef<{ work: (() => void) | undefined; frame: number | undefined }>({
    work: undefined,
    frame: undefined,
  });
  const api = useRef<FrameRequest | undefined>(undefined);
  api.current ??= {
    request: (work) => {
      const current = state.current;
      current.work = work;
      current.frame ??= requestAnimationFrame(() => {
        current.frame = undefined;
        const pending = current.work;
        current.work = undefined;
        pending?.();
      });
    },
    flush: () => {
      const current = state.current;
      if (current.frame !== undefined) cancelAnimationFrame(current.frame);
      current.frame = undefined;
      const pending = current.work;
      current.work = undefined;
      pending?.();
    },
  };
  useEffect(
    () => () => {
      const current = state.current;
      if (current.frame !== undefined) cancelAnimationFrame(current.frame);
      current.frame = undefined;
      current.work = undefined;
    },
    [],
  );
  return api.current;
}
