/** A pointer event as the tool pipeline reads it. A `PointerEvent` satisfies this structurally. */
export interface PointerSource {
  readonly clientX: number;
  readonly clientY: number;
  readonly button: number;
  readonly pressure: number;
  readonly pointerType: string;
  /** The buttons held, as a bit set. Bit 32 is the pen eraser (WEB-PTR-02). */
  readonly buttons?: number;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  /** Full-rate samples since the last event (WEB-PTR-01). Absent where the browser lacks them. */
  getCoalescedEvents?(): readonly PointerSource[];
  /** Predicted samples for the live-preview segment only (WEB-PTR-01). */
  getPredictedEvents?(): readonly PointerSource[];
}

export type PointerPhase = "down" | "move" | "up" | "cancel";

/** A sample in canvas (image) pixels, as a tool runtime receives it. */
export interface ToolSample {
  readonly type: PointerPhase;
  readonly x: number;
  readonly y: number;
  readonly button: number;
  readonly pressure: number;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly predicted?: boolean;
  /** The position in CSS pixels, in client coordinates, for screen-space thresholds. */
  readonly clientX: number;
  readonly clientY: number;
  /** The view's zoom as CSS pixels per canvas pixel, when the mapper knows it. */
  readonly viewScale?: number;
}

/**
 * Maps a client point to canvas pixels, or undefined when no view is laid out yet. `scale` is the
 * view's zoom as CSS pixels per canvas pixel.
 */
export type ImageMapper = (
  clientX: number,
  clientY: number,
) => { x: number; y: number; scale?: number } | undefined;

/** The `button` value a pen reports for its eraser end (WEB-PTR-02). */
const PEN_ERASER_BUTTON = 5;
/** The `buttons` bit that a pen's eraser end sets while it is held. */
const PEN_ERASER_BIT = 32;

/**
 * Whether a pointer is a pen's eraser end (WEB-PTR-02). Pressing the eraser end reports button 5,
 * and while it is held `buttons` has bit 32. A mouse or touch pointer never is.
 */
export function isPenEraser(
  source: Pick<PointerSource, "pointerType" | "button" | "buttons">,
): boolean {
  if (source.pointerType !== "pen") return false;
  return source.button === PEN_ERASER_BUTTON || ((source.buttons ?? 0) & PEN_ERASER_BIT) !== 0;
}

/**
 * The pressure a tool uses (WEB-PTR-02). Only a pen that reports pressure contributes its value.
 * Mouse input and a pen with no pressure use full pressure.
 */
export function effectivePressure(source: Pick<PointerSource, "pointerType" | "pressure">): number {
  return source.pointerType === "pen" && source.pressure > 0 ? source.pressure : 1;
}

/**
 * The samples one browser event produces. A move expands to its coalesced samples, so a stroke
 * keeps the full input rate, and then adds its predicted samples marked as preview-only. Down, up
 * and cancel give one sample each. Samples outside a laid-out view are dropped.
 */
export function toolSamples(
  phase: PointerPhase,
  source: PointerSource,
  toImage: ImageMapper,
): ToolSample[] {
  if (phase !== "move") {
    const sample = sampleOf(phase, source, toImage);
    return sample === undefined ? [] : [sample];
  }
  const coalesced = source.getCoalescedEvents?.() ?? [];
  const events = coalesced.length > 0 ? coalesced : [source];
  const samples = events.flatMap((event) => {
    const sample = sampleOf(phase, event, toImage);
    return sample === undefined ? [] : [sample];
  });
  const predicted = (source.getPredictedEvents?.() ?? []).flatMap((event) => {
    const sample = sampleOf(phase, event, toImage);
    return sample === undefined ? [] : [{ ...sample, predicted: true }];
  });
  return [...samples, ...predicted];
}

function sampleOf(
  phase: PointerPhase,
  source: PointerSource,
  toImage: ImageMapper,
): ToolSample | undefined {
  const point = toImage(source.clientX, source.clientY);
  if (point === undefined) return undefined;
  return {
    type: phase,
    x: point.x,
    y: point.y,
    button: source.button,
    pressure: effectivePressure(source),
    shiftKey: source.shiftKey,
    altKey: source.altKey,
    ctrlKey: source.ctrlKey,
    clientX: source.clientX,
    clientY: source.clientY,
    ...(point.scale !== undefined && { viewScale: point.scale }),
  };
}
