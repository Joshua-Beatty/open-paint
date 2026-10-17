/** A dialog's offset from where the overlay centres it, in CSS px. */
export interface DialogOffset {
  readonly x: number;
  readonly y: number;
}

/** A box in viewport CSS px. */
export interface DialogBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * How much of the title bar stays on screen horizontally, so it can always be grabbed again: at
 * the left edge the close button takes about 36 px of it, which leaves room to grab beside it.
 */
export const DIALOG_MIN_VISIBLE = 96;

export const CENTRED: DialogOffset = { x: 0, y: 0 };

/**
 * The offset nearest `offset` that keeps the title bar reachable: at least `minVisible` px of it
 * inside the viewport horizontally, and all of it vertically. `bar` is the title bar's box with the
 * dialog centred (offset 0). A bar taller than the viewport keeps its top edge on screen.
 */
export function clampDialogOffset(
  offset: DialogOffset,
  bar: DialogBox,
  viewport: { readonly width: number; readonly height: number },
  minVisible = DIALOG_MIN_VISIBLE,
): DialogOffset {
  const visible = Math.min(minVisible, Math.max(0, bar.right - bar.left));
  const minX = visible - bar.right;
  const maxX = viewport.width - visible - bar.left;
  const minY = -bar.top;
  const maxY = Math.max(minY, viewport.height - bar.bottom);
  return {
    x: Math.min(Math.max(offset.x, minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(offset.y, minY), maxY),
  };
}

/** Whether `offset` already keeps the title bar reachable, so clamping would not move it. */
export function isDialogOffsetReachable(
  offset: DialogOffset,
  bar: DialogBox,
  viewport: { readonly width: number; readonly height: number },
  minVisible = DIALOG_MIN_VISIBLE,
): boolean {
  const clamped = clampDialogOffset(offset, bar, viewport, minVisible);
  return Math.abs(clamped.x - offset.x) < 0.5 && Math.abs(clamped.y - offset.y) < 0.5;
}

/**
 * Where each kind of dialog was left, for this session only: reopening a dialog puts it back there.
 * Nothing is saved across reloads.
 */
const positions = new Map<string, DialogOffset>();

export function rememberedDialogOffset(key: string): DialogOffset | undefined {
  return positions.get(key);
}

export function rememberDialogOffset(key: string, offset: DialogOffset): void {
  if (offset.x === 0 && offset.y === 0) positions.delete(key);
  else positions.set(key, offset);
}

/** Forgets every remembered position (for tests). */
export function forgetDialogOffsets(): void {
  positions.clear();
}
