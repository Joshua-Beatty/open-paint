import { type RefObject, useLayoutEffect, useState } from "react";
import { canvasScale } from "../canvas-scale";

/** A canvas's backing size in device pixels, and the device pixels per CSS pixel it uses. */
export interface BackingSize {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

/**
 * Keeps a canvas's backing store at its CSS size in device pixels (WEB-GPU-07), at the engine
 * canvas's scale (`canvasScale`), so an overlay's pixels are the engine's. The canvas must be sized
 * by CSS, and the returned size goes to its `width` and `height` attributes.
 */
export function useCanvasBacking(ref: RefObject<HTMLCanvasElement | null>): BackingSize {
  const [size, setSize] = useState<BackingSize>({ width: 0, height: 0, scale: canvasScale.value });
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const update = () => {
      const scale = canvasScale.value;
      const width = Math.round(canvas.clientWidth * scale);
      const height = Math.round(canvas.clientHeight * scale);
      setSize((previous) =>
        previous.width === width && previous.height === height && previous.scale === scale
          ? previous
          : { width, height, scale },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(canvas);
    const unsubscribe = canvasScale.subscribe(update);
    return () => {
      observer.disconnect();
      unsubscribe();
    };
  }, [ref]);
  return size;
}
