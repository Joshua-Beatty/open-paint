import { HandleStore } from "./handle-store";
import type { PixelPoint } from "./select-geometry";

/** What the canvas shows for a pending Magic Wand or Paint Bucket result (TL-FRAME-06). */
export interface WandHandles {
  /** The origin handle, at the seed point. */
  readonly seed?: PixelPoint;
  /** The move handle, at the centre of the selection. */
  readonly move?: PixelPoint;
  /** The click point of a flood that is still computing. The busy spinner shows there. */
  readonly busy?: PixelPoint;
}

/** The handles of the flood tools, read by the canvas overlay through `useSyncExternalStore`. */
export const wandHandles = new HandleStore<WandHandles>({});
