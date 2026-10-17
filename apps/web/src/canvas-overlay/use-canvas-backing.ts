import { type RefObject, useLayoutEffect, useState } from "react";

/** A canvas's backing size in device pixels. */
export interface BackingSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Keeps a canvas's backing store at its CSS size in device pixels (WEB-GPU-07). The canvas must be
 * sized by CSS, and the returned size goes to its `width` and `height` attributes.
 */
export function useCanvasBacking(ref: RefObject<HTMLCanvasElement | null>): BackingSize {
  const [size, setSize] = useState<BackingSize>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const update = () => {
      const width = Math.round(canvas.clientWidth * devicePixelRatio);
      const height = Math.round(canvas.clientHeight * devicePixelRatio);
      setSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
