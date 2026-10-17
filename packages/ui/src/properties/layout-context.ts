import { createContext } from "react";

/**
 * How a form lays out its controls. `stacked` is the dialog and settings layout: a heading above
 * each control, with a reset button and notes. `inline` is the one-row toolbar layout: each control
 * is a single compact item no taller than the row, named by a short label or an icon and tooltip.
 */
export type ControlLayout = "stacked" | "inline";

export const ControlLayoutContext = createContext<ControlLayout>("stacked");

/** Marks one item of a one-row strip, which the strip's overflow menu can take in (OverflowRow). */
export const STRIP_ITEM_ATTRIBUTE = "data-strip-item";
