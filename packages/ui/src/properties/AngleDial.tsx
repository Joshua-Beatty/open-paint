import type { KeyboardEvent, PointerEvent } from "react";
import { useRef } from "react";
import {
  angleOf,
  clampTo,
  keyboardValue,
  type Range,
  type StepSettings,
  snapValue,
  wrapValue,
} from "./control-math";
import { useFrameRequest } from "./use-frame-request";

export interface AngleDialProps {
  /** The accessible name of the dial. */
  readonly name: string;
  /** Degrees, measured clockwise from 3 o'clock. */
  readonly value: number;
  readonly range: Range;
  readonly steps: StepSettings;
  readonly wraps: boolean;
  readonly disabled: boolean;
  readonly onChange: (degrees: number) => void;
}

/**
 * A circular angle dial (FX-FW-UI-02 angle chooser). Dragging on the dial sets the angle from the
 * pointer's direction. The keyboard moves the angle with the slider keys.
 */
export function AngleDial({
  name,
  value,
  range,
  steps,
  wraps,
  disabled,
  onChange,
}: AngleDialProps) {
  const dialRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  // A drag sets the value at most once per frame, where the pointer is then (L1).
  const frame = useFrameRequest();

  const pick = (clientX: number, clientY: number) => {
    const rect = dialRef.current?.getBoundingClientRect();
    if (rect === undefined || !(rect.width > 0)) return;
    const angle = angleOf(
      clientX - (rect.left + rect.width / 2),
      clientY - (rect.top + rect.height / 2),
    );
    const inRange = wraps ? wrapValue(angle, range) : clampTo(angle, range);
    onChange(snapValue(inRange, range, steps.small));
  };

  return (
    <div
      ref={dialRef}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={name}
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      aria-valuenow={value}
      aria-valuetext={`${value.toFixed(0)}°`}
      aria-disabled={disabled}
      className="prop-dial"
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
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (disabled) return;
        const next = keyboardValue(event.key, value, steps, range, wraps);
        if (next === undefined) return;
        event.preventDefault();
        onChange(snapValue(next, range, steps.small));
      }}
    >
      <span className="prop-dial-needle" style={{ transform: `rotate(${value}deg)` }} />
    </div>
  );
}
