import { BINS, type ChannelMask, histogramPolygon, largestBin } from "./levels-model";

/** The drawing size of the histogram in its own units. CSS stretches it vertically. */
const WIDTH = 120;
const HEIGHT = 256;
/** Fill opacity of a checked channel and an unchecked one (ADJ-LEVELS-UI-06). */
const CHECKED_OPACITY = 0.627;
const UNCHECKED_OPACITY = 0.188;
/** Outline width in CSS pixels (ADJ-LEVELS-UI-06). */
const OUTLINE_WIDTH = 1.3;
/** Channel colors, pure red, green and blue, blended toward the theme's base (ADJ-LEVELS-UI-06). */
const CHANNEL_COLORS = [
  "color-mix(in srgb, #ff0000 50%, var(--levels-blend))",
  "color-mix(in srgb, #00ff00 50%, var(--levels-blend))",
  "color-mix(in srgb, #0000ff 50%, var(--levels-blend))",
] as const;

export interface LevelsHistogramProps {
  /** 768 bins: 256 each for R, G and B. */
  readonly histogram: ArrayLike<number>;
  /** The input histogram grows leftward from the right edge; the output grows from the left. */
  readonly mirrored: boolean;
  readonly mask: ChannelMask;
  readonly title: string;
}

/**
 * One histogram of the Levels dialog (ADJ-LEVELS-UI-06): a vertical plot where level 0 is at the
 * bottom and 255 at the top, and the bins extend horizontally. The blue, green and red polygons are
 * drawn in that order, so red sits on top.
 */
export function LevelsHistogram({ histogram, mirrored, mask, title }: LevelsHistogramProps) {
  const maxBin = largestBin(histogram);
  const size = { width: WIDTH, height: HEIGHT };
  return (
    <svg
      className="levels-histogram"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={title}
    >
      {[2, 1, 0].map((channel) => {
        const bins = Array.from(
          { length: BINS },
          (_, value) => histogram[channel * BINS + value] ?? 0,
        );
        return (
          <polygon
            key={channel}
            points={histogramPolygon(bins, maxBin, size, mirrored)}
            style={{ fill: CHANNEL_COLORS[channel], stroke: CHANNEL_COLORS[channel] }}
            fillOpacity={mask[channel] ? CHECKED_OPACITY : UNCHECKED_OPACITY}
            strokeWidth={OUTLINE_WIDTH}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </svg>
  );
}
