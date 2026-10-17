import { iconShape } from "@openpaint/properties";
import { Icon } from "@openpaint/ui";
import { PHOSPHOR, REMIX } from "../icons/icon-set";

/** The icon data of each tool's icon (`iconShape`), keyed by its icon id (`tool.<id>`). */
const ICONS: Readonly<Record<string, string>> = {
  "tool.rectangleSelect": PHOSPHOR.selection,
  "tool.moveSelectedPixels": PHOSPHOR.arrowsOutCardinal,
  "tool.lassoSelect": PHOSPHOR.lasso,
  "tool.moveSelection": PHOSPHOR.selectionForeground,
  "tool.ellipseSelect": PHOSPHOR.circleDashed,
  "tool.zoom": REMIX.zoomIn,
  "tool.magicWand": PHOSPHOR.magicWand,
  "tool.pan": PHOSPHOR.hand,
  "tool.paintBucket": PHOSPHOR.paintBucket,
  "tool.gradient": PHOSPHOR.gradient,
  "tool.paintbrush": PHOSPHOR.paintBrush,
  "tool.eraser": PHOSPHOR.eraser,
  "tool.pencil": PHOSPHOR.pencilSimple,
  "tool.colorPicker": PHOSPHOR.eyedropper,
  "tool.cloneStamp": PHOSPHOR.stamp,
  "tool.recolor": PHOSPHOR.paintRoller,
  "tool.text": PHOSPHOR.textT,
  // A curve stroked on the 16 px grid, at the icon set's weight.
  "tool.lineCurve": "M2.5 13c3-8 8-8 11-1",
  "tool.shapes": REMIX.shapes,
};

/** The icon data of a tool icon, or undefined for an unknown icon id. */
export function toolIconData(icon: string): string | undefined {
  return ICONS[icon];
}

/**
 * Icons for a tool button that spans both columns of the Tools panel: several icons of the set,
 * each on its own 256 unit square, side by side. Shapes shows a square, a circle and a triangle.
 */
const WIDE_ICONS: Readonly<Record<string, readonly string[]>> = {
  "tool.shapes": [PHOSPHOR.square, PHOSPHOR.circle, PHOSPHOR.triangle],
};

/** The icons drawn side by side for a double-wide button, or undefined when the tool has none. */
export function wideToolIconData(icon: string): readonly string[] | undefined {
  return WIDE_ICONS[icon];
}

const WIDE_GRID = 256;

export interface ToolIconProps {
  readonly icon: string;
  /** The button spans both columns, so a wide composition is drawn where the tool has one. */
  readonly wide?: boolean;
}

export function ToolIcon({ icon, wide = false }: ToolIconProps) {
  const parts = wide ? wideToolIconData(icon) : undefined;
  if (parts === undefined) return <Icon icon={toolIconData(icon) ?? ""} className="tool-icon" />;
  return (
    <svg
      className="tool-icon icon-filled is-wide"
      viewBox={`0 0 ${WIDE_GRID * parts.length} ${WIDE_GRID}`}
      aria-hidden="true"
      focusable="false"
    >
      {parts.map((part, index) => (
        <path
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts are fixed and ordered
          key={index}
          transform={`translate(${index * WIDE_GRID} 0)`}
          d={iconShape(part).path}
        />
      ))}
    </svg>
  );
}
