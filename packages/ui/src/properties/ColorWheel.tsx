import type { PointerEvent } from "react";
import { useRef } from "react";
import { wheelPick, wheelPosition } from "./color-math";
import { useFrameRequest } from "./use-frame-request";

export interface ColorWheelProps {
  /** Hue in degrees. */
  readonly hue: number;
  /** Saturation in [0, 1]. */
  readonly saturation: number;
  readonly color: string;
  readonly disabled: boolean;
  readonly onPick: (hue: number, saturation: number) => void;
}

/**
 * The HSV color wheel (FX-FW-UI-02 color wheel). Hue is the angle and saturation the radius. The
 * value, saturation and alpha sliders beside it are the keyboard path, so the wheel is pointer-only.
 */
export function ColorWheel({ hue, saturation, color, disabled, onPick }: ColorWheelProps) {
  const wheelRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  // A drag sets the value at most once per frame, where the pointer is then (L1).
  const frame = useFrameRequest();
  const nub = wheelPosition(hue, saturation);

  const pick = (clientX: number, clientY: number) => {
    const rect = wheelRef.current?.getBoundingClientRect();
    if (rect === undefined || !(rect.width > 0)) return;
    const radius = rect.width / 2;
    const point = wheelPick(
      (clientX - (rect.left + radius)) / radius,
      (clientY - (rect.top + radius)) / radius,
    );
    onPick(point.h, point.s);
  };

  return (
    <div
      ref={wheelRef}
      aria-hidden="true"
      className="prop-wheel"
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
        className="prop-wheel-nub"
        style={{
          left: `${50 + nub.x * 50}%`,
          top: `${50 + nub.y * 50}%`,
          background: color,
        }}
      />
    </div>
  );
}
