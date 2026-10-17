import { type PointerEvent, useState } from "react";
import { nearestNub, SHOWN_MAX } from "./levels-model";

export interface GradientSliderProps {
  /** The accessible name of the bar. */
  readonly label: string;
  /** The nub values, 0..255 from the bottom, in order. */
  readonly nubs: readonly number[];
  /** The color at the top of the bar. The bottom is black (ADJ-LEVELS-UI-03). */
  readonly maxColor: string;
  readonly disabled: boolean;
  /** Called with the raw pointer value while a nub is dragged. The caller keeps it in bounds. */
  readonly onNubChange: (index: number, value: number) => void;
}

/**
 * A vertical gradient bar with triangular nubs (ADJ-LEVELS-UI-03). A primary press picks the nub
 * nearest to the pointer, and the drag keeps it under the pointer through pointer capture
 * (WEB-PTR-04). The nub under the pointer is highlighted while nothing is dragged.
 */
export function GradientSlider({
  label,
  nubs,
  maxColor,
  disabled,
  onNubChange,
}: GradientSliderProps) {
  const [active, setActive] = useState<number | undefined>(undefined);
  const [hover, setHover] = useState<number | undefined>(undefined);

  const valueAt = (event: PointerEvent<HTMLDivElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = rect.height > 0 ? (rect.bottom - event.clientY) / rect.height : 0;
    return Math.min(Math.max(fraction * SHOWN_MAX, 0), SHOWN_MAX);
  };

  return (
    <div
      className="levels-gradient"
      title={label}
      data-disabled={disabled ? "" : undefined}
      style={{ background: `linear-gradient(to top, black, ${maxColor})` }}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return;
        const value = valueAt(event);
        const index = nearestNub(value, nubs);
        event.currentTarget.setPointerCapture(event.pointerId);
        setActive(index);
        setHover(index);
        onNubChange(index, value);
      }}
      onPointerMove={(event) => {
        if (disabled) return;
        const value = valueAt(event);
        if (active !== undefined) {
          onNubChange(active, value);
          return;
        }
        setHover(nearestNub(value, nubs));
      }}
      onPointerUp={() => setActive(undefined)}
      onPointerCancel={() => setActive(undefined)}
      onPointerLeave={() => {
        if (active === undefined) setHover(undefined);
      }}
    >
      {nubs.map((nub, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: nubs keep their order and count
          key={index}
          className={
            index === (active ?? hover) && !disabled ? "levels-nub is-highlighted" : "levels-nub"
          }
          style={{ bottom: `${(nub / SHOWN_MAX) * 100}%` }}
        />
      ))}
    </div>
  );
}
