import type { CSSProperties, PointerEvent } from "react";
import { useRef } from "react";
import { fractionAtPoint, fractionOf, type Range, valueAtFraction } from "./control-math";
import { useFrameRequest } from "./use-frame-request";

export interface TwoAxisPadProps {
  readonly x: number;
  readonly y: number;
  readonly rangeX: Range;
  readonly rangeY: Range;
  /** A circle for a roll ball (trackball), a rectangle for a pan pad. */
  readonly circular: boolean;
  /** An image shown under the pad, for example a thumbnail of the source layer. */
  readonly underlay?: string;
  readonly disabled: boolean;
  readonly onChange: (x: number, y: number) => void;
}

/**
 * The 2-D pan pad (FX-FW-UI-02, EXT-06C-01). It is a pointer surface: the X and Y sliders beside it
 * are the keyboard path, so the pad is hidden from assistive technology. Y grows downwards, the same
 * as the image's pixel rows.
 */
export function TwoAxisPad({
  x,
  y,
  rangeX,
  rangeY,
  circular,
  underlay,
  disabled,
  onChange,
}: TwoAxisPadProps) {
  const padRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  // A drag sets the value at most once per frame, where the pointer is then (L1).
  const frame = useFrameRequest();

  const pick = (clientX: number, clientY: number) => {
    const rect = padRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    const fx = fractionAtPoint(clientX, rect.left, rect.width);
    const fy = fractionAtPoint(clientY, rect.top, rect.height);
    if (fx === undefined || fy === undefined) return;
    onChange(valueAtFraction(fx, rangeX), valueAtFraction(fy, rangeY));
  };

  const style: CSSProperties | undefined =
    underlay === undefined ? undefined : { backgroundImage: `url("${underlay}")` };

  return (
    <div
      ref={padRef}
      aria-hidden="true"
      className={circular ? "prop-pad is-circular" : "prop-pad"}
      style={style}
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        if (disabled) return;
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        pick(event.clientX, event.clientY);
      }}
      onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
        if (!dragging.current) return;
        const { clientX, clientY } = event;
        frame.request(() => pick(clientX, clientY));
      }}
      onPointerUp={() => {
        dragging.current = false;
        frame.flush();
      }}
      onPointerCancel={() => {
        dragging.current = false;
        frame.flush();
      }}
    >
      <span
        className="prop-pad-nub"
        style={{
          left: `${fractionOf(x, rangeX) * 100}%`,
          top: `${fractionOf(y, rangeY) * 100}%`,
        }}
      />
    </div>
  );
}
