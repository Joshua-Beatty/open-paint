import { Document } from "@openpaint/document";
import { newDocumentAccountant } from "../errors/memory-budget";
import type { OpenImage } from "./open-image";

/** SET-LIFE-10: the size of the blank image a first launch opens. */
export const FIRST_RUN_WIDTH = 800;
export const FIRST_RUN_HEIGHT = 600;

/** SET-LIFE-10: a blank 800 x 600 image with its white background layer, opened as `name`. */
export function createFirstRunImage(name: string): OpenImage {
  return {
    name,
    document: Document.createBlank({
      width: FIRST_RUN_WIDTH,
      height: FIRST_RUN_HEIGHT,
      accountant: newDocumentAccountant(),
    }),
  };
}
