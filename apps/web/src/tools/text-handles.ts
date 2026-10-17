import { HandleStore } from "./handle-store";

/** The text block's box and its line metrics, in image pixels. */
export interface TextBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A point and a height, in image pixels. */
export interface TextCaret {
  readonly x: number;
  readonly y: number;
  readonly height: number;
}

/**
 * What the canvas shows for the text being edited (TL-TEXT-01): the box, the caret while it is on,
 * and the move handle. The caret and the handle are omitted while Ctrl hides them.
 */
export interface TextHandles {
  readonly box?: TextBox;
  readonly caret?: TextCaret;
  /** The move handle, at the box's top right corner. */
  readonly handle?: { readonly x: number; readonly y: number };
}

/** The handles of the Text tool, read by the canvas overlay through `useSyncExternalStore`. */
export const textHandles = new HandleStore<TextHandles>({});
