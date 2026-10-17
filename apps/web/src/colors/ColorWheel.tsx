import { type PointerEvent, useRef, useState } from "react";
import {
  hsvToRgb,
  type Rgba,
  rgbToHsv,
  WHEEL_HUE_BACKGROUND,
  wheelPick,
  wheelPosition,
  wheelSaturationGradient,
} from "./color-math";

export interface ColorWheelProps {
  /** The color the wheel edits. */
  readonly color: Rgba;
  /** The other color (secondary while primary is edited). Its nub shows while the wheel is dragged. */
  readonly other?: Rgba;
  readonly onChange: (color: Rgba) => void;
  readonly label: string;
}

/**
 * The HSV color wheel (UI-FTW-06). Hue is the angle and saturation the radius. Dragging sets the
 * color. Shift snaps the hue to 15 degrees, Ctrl locks the radius, and Alt locks the hue. The
 * other color's nub fades in while the wheel is dragged and fades out on release. The keyboard
 * edits the same values through the H, S and V sliders.
 */
export function ColorWheel({ color, other, onChange, label }: ColorWheelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [dragged, setDragged] = useState(false);
  const hsv = rgbToHsv(color);
  const nub = wheelPosition(hsv);
  const otherNub = other === undefined ? undefined : wheelPosition(rgbToHsv(other));

  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) return;
    const radius = rect.width / 2;
    const x = (event.clientX - (rect.left + radius)) / radius;
    const y = (event.clientY - (rect.top + radius)) / radius;
    const next = wheelPick(hsv, x, y, {
      shift: event.shiftKey,
      ctrl: event.ctrlKey,
      alt: event.altKey,
    });
    onChange(hsvToRgb(next, color.a));
  };

  const release = () => {
    dragging.current = false;
    setDragged(false);
  };

  return (
    <div
      ref={ref}
      role="img"
      aria-label={label}
      className="color-wheel"
      style={{ background: `${wheelSaturationGradient()}, ${WHEEL_HUE_BACKGROUND}` }}
      onPointerDown={(event) => {
        dragging.current = true;
        setDragged(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        pick(event);
      }}
      onPointerMove={(event) => {
        if (dragging.current) pick(event);
      }}
      onPointerUp={release}
      onPointerCancel={release}
    >
      {other !== undefined && otherNub !== undefined && (
        <span
          className={dragged ? "color-wheel-nub is-other is-shown" : "color-wheel-nub is-other"}
          style={{
            left: `${50 + otherNub.x * 50}%`,
            top: `${50 + otherNub.y * 50}%`,
            background: `rgb(${other.r},${other.g},${other.b})`,
          }}
        />
      )}
      <span
        className="color-wheel-nub"
        style={{
          left: `${50 + nub.x * 50}%`,
          top: `${50 + nub.y * 50}%`,
          background: `rgb(${color.r},${color.g},${color.b})`,
        }}
      />
    </div>
  );
}
