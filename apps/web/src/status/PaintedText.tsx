import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** How long text must stay unchanged before the accessible copy follows it. */
export const ACCESSIBLE_TEXT_DELAY_MS = 400;

/**
 * The fitted text for `width`: the whole text, or as much as fits with an ellipsis.
 * `measure` gives a string's width in the same units as `width`.
 */
export function fitText(text: string, width: number, measure: (text: string) => number): string {
  if (measure(text) <= width) return text;
  const ellipsis = "…";
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(text.slice(0, middle) + ellipsis) <= width) low = middle;
    else high = middle - 1;
  }
  return low === 0 ? "" : text.slice(0, low) + ellipsis;
}

/**
 * Text that changes with every pointer move (the cursor position, a drag's size), drawn into a
 * canvas instead of the DOM. Any DOM change makes the page repaint, and Firefox answers each page
 * repaint by reading the engine's WebGPU canvas back on the engine worker when it has no new frame,
 * which for a large canvas takes tens of milliseconds: a status bar updated per pointer move kept
 * the worker busy, so strokes started a quarter second late. A canvas update repaints only itself.
 *
 * Assistive technology reads a visually hidden copy that follows the text once it has been steady
 * for `ACCESSIBLE_TEXT_DELAY_MS`, so a drag does not announce every step (and repaints once).
 */
export function PaintedText({
  text,
  className,
  title,
  live,
}: {
  text: string;
  className?: string;
  title?: string;
  /** Announces the steady text politely (the context text). */
  live?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0, scale: 1 });
  const [spoken, setSpoken] = useState(text);

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const update = () => {
      const scale = globalThis.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      setSize((previous) =>
        previous.width === width && previous.height === height && previous.scale === scale
          ? previous
          : { width, height, scale },
      );
    };
    update();
    if (typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || size.width === 0 || size.height === 0) return;
    const backingWidth = Math.round(size.width * size.scale);
    const backingHeight = Math.round(size.height * size.scale);
    if (canvas.width !== backingWidth) canvas.width = backingWidth;
    if (canvas.height !== backingHeight) canvas.height = backingHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    const style = getComputedStyle(canvas);
    context.setTransform(size.scale, 0, 0, size.scale, 0, 0);
    context.clearRect(0, 0, size.width, size.height);
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    context.fillStyle = style.color;
    context.textBaseline = "middle";
    const shown = fitText(text, size.width, (value) => context.measureText(value).width);
    context.fillText(shown, 0, size.height / 2);
  }, [text, size]);

  useEffect(() => {
    if (spoken === text) return undefined;
    const timer = setTimeout(() => setSpoken(text), ACCESSIBLE_TEXT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, spoken]);

  return (
    <span className={className} title={title}>
      <span className="app-painted-text" aria-hidden="true">
        <canvas ref={ref} />
      </span>
      <span className="visually-hidden" {...(live && { "aria-live": "polite" })}>
        {spoken}
      </span>
    </span>
  );
}
