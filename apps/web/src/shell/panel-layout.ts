/**
 * The docked panels and their sidebar layout (UI-FTW-01..08, SET-LIFE-04). Pure functions over a
 * `PanelLayout`, so the height rules, splitter math and width clamping need no DOM.
 */

export const PANEL_IDS = ["tools", "colors", "layers", "history"] as const;
export type PanelId = (typeof PANEL_IDS)[number];

/** The panels of the right sidebar, top to bottom (UI-FTW-01). */
export const RIGHT_PANEL_IDS = ["colors", "layers", "history"] as const;
export type RightPanelId = (typeof RIGHT_PANEL_IDS)[number];

/** Height of a panel header, in CSS px. Matches `.app-panel-header` in shell.css. */
export const PANEL_HEADER_HEIGHT = 26;

/** Height of the splitter between two panels, in CSS px. Matches `.app-splitter` in shell.css. */
export const SPLITTER_HEIGHT = 4;

/**
 * Minimum panel bodies, header excluded (UI-FTW-01). Colors is its compact or expanded content
 * height at the widest sidebar, where the palette's swatches are largest: 6 px padding, the 60 px
 * chips, the 6 rows of 16 px swatches and, expanded, the 212 px editor (shell.css), with 6 px gaps.
 */
const COLORS_COMPACT_MIN = 180;
const COLORS_EXPANDED_MIN = 397;
const LAYERS_MIN = 120;
const HISTORY_MIN = 96;

/** The share of the space left after Colors that goes to Layers and History by default. */
const DEFAULT_WEIGHTS: Readonly<Record<RightPanelId, number>> = {
  colors: 0,
  layers: 0.7,
  history: 0.3,
};

export const RIGHT_SIDEBAR = {
  min: 220,
  max: 480,
  default: 280,
  /** Below this viewport width the right sidebar uses its minimum width (UI-FTW-08). */
  narrowViewport: 1280,
  /** Keyboard step for the width splitter, in CSS px. */
  keyboardStep: 8,
} as const;

/** The settings that describe the docked panels, read into one value (SET-STO-03). */
export interface PanelLayout {
  readonly visible: Readonly<Record<PanelId, boolean>>;
  /** Always false for Tools, which has no collapse chevron (UI-FTW-01). */
  readonly collapsed: Readonly<Record<PanelId, boolean>>;
  readonly colorsExpanded: boolean;
  readonly rightSidebarWidth: number;
  /** Shares of Colors, Layers and History (sum 1), or [] for the default arrangement. */
  readonly splitRatios: readonly number[];
}

export const DEFAULT_PANEL_LAYOUT: PanelLayout = {
  visible: { tools: true, colors: true, layers: true, history: true },
  collapsed: { tools: false, colors: false, layers: false, history: false },
  colorsExpanded: false,
  rightSidebarWidth: RIGHT_SIDEBAR.default,
  splitRatios: [],
};

/** Panel body heights in CSS px, header and splitters excluded. Closed panels are 0. */
export type Bodies = Readonly<Record<RightPanelId, number>>;

export function minimumBody(panel: RightPanelId, colorsExpanded: boolean): number {
  if (panel === "colors") return colorsExpanded ? COLORS_EXPANDED_MIN : COLORS_COMPACT_MIN;
  return panel === "layers" ? LAYERS_MIN : HISTORY_MIN;
}

/** Whether a right-sidebar panel is shown and not collapsed, so it has a body. */
export function isPanelOpen(layout: PanelLayout, panel: RightPanelId): boolean {
  return layout.visible[panel] && !layout.collapsed[panel];
}

/** The visible right-sidebar panels, top to bottom. */
export function visibleRightPanels(layout: PanelLayout): RightPanelId[] {
  return RIGHT_PANEL_IDS.filter((panel) => layout.visible[panel]);
}

/** The height left for panel bodies once headers and splitters take their share. */
export function bodySpace(layout: PanelLayout, total: number): number {
  const visible = visibleRightPanels(layout).length;
  const chrome = visible * PANEL_HEADER_HEIGHT + Math.max(0, visible - 1) * SPLITTER_HEIGHT;
  return Math.floor(Math.max(0, total - chrome));
}

/**
 * Body heights of the right sidebar for a sidebar of `total` CSS px. Open panels share the space
 * by their split shares, or by the default arrangement when there are none. Every open panel gets
 * at least its minimum.
 *
 * Expanded Colors takes the height its editor needs and Layers and History shrink for it, down to
 * their minimums. When even that is too short, Colors gives up height first, down to its compact
 * height, and scrolls inside, so the panels below keep their toolbars in view (UI-FTW-06). Only
 * when the compact minimums do not fit do the minimums win, and the sidebar overflows and clips.
 * The split shares are not changed, so compacting Colors again restores the earlier heights.
 */
export function rightBodies(layout: PanelLayout, total: number): Bodies {
  const bodies: Record<RightPanelId, number> = { colors: 0, layers: 0, history: 0 };
  const open = RIGHT_PANEL_IDS.filter((panel) => isPanelOpen(layout, panel));
  if (open.length === 0) return bodies;
  const space = bodySpace(layout, total);
  const ratios = layout.splitRatios.length === RIGHT_PANEL_IDS.length ? layout.splitRatios : null;
  const othersMin = open
    .filter((panel) => panel !== "colors")
    .reduce((sum, panel) => sum + minimumBody(panel, false), 0);
  const minimumOf = (panel: RightPanelId): number => {
    if (panel !== "colors" || !layout.colorsExpanded) return minimumBody(panel, false);
    const room = Math.max(COLORS_COMPACT_MIN, space - othersMin);
    return Math.min(COLORS_EXPANDED_MIN, room);
  };
  const items = open.map((panel): FillItem => {
    const min = minimumOf(panel);
    if (ratios !== null) {
      const index = RIGHT_PANEL_IDS.indexOf(panel);
      return { id: panel, min, weight: Math.max(0, ratios[index] ?? 0), pinned: false };
    }
    // The default arrangement keeps Colors at its content height and splits the rest 70/30.
    return { id: panel, min, weight: DEFAULT_WEIGHTS[panel], pinned: panel === "colors" };
  });
  const sizes = fill(space, items);
  let used = 0;
  for (const panel of open) {
    // The epsilon keeps an exact share such as 198 from floating to 197.999… and losing a pixel.
    const size = Math.floor((sizes.get(panel) ?? 0) + 1e-9);
    bodies[panel] = size;
    used += size;
  }
  // Rounding leaves a few pixels. The last open panel takes them so the bodies fill the space.
  const last = open[open.length - 1];
  if (last !== undefined && used < space) bodies[last] += space - used;
  return bodies;
}

interface FillItem {
  readonly id: RightPanelId;
  readonly min: number;
  readonly weight: number;
  readonly pinned: boolean;
}

/**
 * Shares `space` by weight. An item that would fall below its minimum is fixed at the minimum
 * and the rest share what is left, repeatedly until nothing falls below its minimum.
 */
function fill(space: number, items: readonly FillItem[]): Map<RightPanelId, number> {
  const sizes = new Map<RightPanelId, number>();
  let remaining = space;
  let free: FillItem[] = [];
  for (const item of items) {
    if (item.pinned) {
      sizes.set(item.id, item.min);
      remaining -= item.min;
    } else {
      free.push(item);
    }
  }
  while (free.length > 0) {
    const weights = free.reduce((sum, item) => sum + item.weight, 0);
    const under = free.find((item) => shareOf(item, remaining, weights, free.length) < item.min);
    if (under === undefined) {
      for (const item of free) {
        sizes.set(item.id, shareOf(item, remaining, weights, free.length));
      }
      break;
    }
    sizes.set(under.id, under.min);
    remaining -= under.min;
    free = free.filter((item) => item !== under);
  }
  return sizes;
}

function shareOf(item: FillItem, space: number, weights: number, count: number): number {
  return weights > 0 ? (space * item.weight) / weights : space / count;
}

/**
 * The split shares that give these body heights (SET-STO-03). Open panels take their share of the
 * stored shares' total. Hidden or collapsed panels keep their stored share, and with none stored
 * they get the average of the open ones. The result is normalized to sum 1.
 */
export function ratiosFromBodies(bodies: Bodies, layout: PanelLayout): number[] {
  const prev = layout.splitRatios.length === RIGHT_PANEL_IDS.length ? layout.splitRatios : null;
  const open = RIGHT_PANEL_IDS.filter((panel) => isPanelOpen(layout, panel));
  const previousOf = (panel: RightPanelId) => prev?.[RIGHT_PANEL_IDS.indexOf(panel)] ?? 0;
  if (open.length === 0) return prev === null ? [1 / 3, 1 / 3, 1 / 3] : [...prev];
  const openTotal = open.reduce((sum, panel) => sum + bodies[panel], 0);
  const previousOpen = prev === null ? 1 : open.reduce((sum, panel) => sum + previousOf(panel), 0);
  const scale = previousOpen > 0 ? previousOpen : 1;
  const shares = RIGHT_PANEL_IDS.map((panel) => {
    if (open.includes(panel)) {
      const share = openTotal > 0 ? bodies[panel] / openTotal : 1 / open.length;
      return share * scale;
    }
    return prev === null ? scale / open.length : previousOf(panel);
  });
  const sum = shares.reduce((total, value) => total + value, 0);
  if (sum <= 0) return [1 / 3, 1 / 3, 1 / 3];
  return shares.map((value) => value / sum);
}

/**
 * Moves the boundary between two adjacent open panels by `delta` px. The upper panel keeps its
 * minimum and so does the lower one, and the two heights always add up to the same total.
 */
export function moveSplitter(
  bodies: Bodies,
  upper: RightPanelId,
  lower: RightPanelId,
  delta: number,
  colorsExpanded: boolean,
): Bodies {
  const pair = bodies[upper] + bodies[lower];
  const minUpper = minimumBody(upper, colorsExpanded);
  const minLower = minimumBody(lower, colorsExpanded);
  const high = Math.max(minUpper, pair - minLower);
  const next = Math.min(high, Math.max(minUpper, bodies[upper] + delta));
  const result: Record<RightPanelId, number> = { ...bodies };
  result[upper] = next;
  result[lower] = pair - next;
  return result;
}

/**
 * Whether the splitter between two panels can move. Both need a body, and expanded Colors keeps
 * the height its editor needs, so the splitter under it stays put while it is expanded.
 */
export function isSplitterMovable(
  layout: PanelLayout,
  upper: RightPanelId,
  lower: RightPanelId,
): boolean {
  if (!isPanelOpen(layout, upper) || !isPanelOpen(layout, lower)) return false;
  return !(layout.colorsExpanded && (upper === "colors" || lower === "colors"));
}

/**
 * The split shares to store after a splitter moves to give these body heights in a sidebar of
 * `total` CSS px. While Colors is expanded the shares describe the compact arrangement: Colors
 * keeps its compact height, and Layers and History keep the proportion the drag gave them, so
 * compacting Colors restores its earlier height.
 */
export function splitRatiosFor(bodies: Bodies, layout: PanelLayout, total: number): number[] {
  if (!layout.colorsExpanded || !isPanelOpen(layout, "colors")) {
    return ratiosFromBodies(bodies, layout);
  }
  const compact: PanelLayout = { ...layout, colorsExpanded: false };
  const before = rightBodies(compact, total);
  const others = RIGHT_PANEL_IDS.filter(
    (panel) => panel !== "colors" && isPanelOpen(layout, panel),
  );
  const draggedTotal = others.reduce((sum, panel) => sum + bodies[panel], 0);
  const compactTotal = others.reduce((sum, panel) => sum + before[panel], 0);
  const scaled: Record<RightPanelId, number> = { ...before };
  for (const panel of others) {
    scaled[panel] = draggedTotal > 0 ? (bodies[panel] * compactTotal) / draggedTotal : 0;
  }
  return ratiosFromBodies(scaled, compact);
}

/** Clamps a right-sidebar width to its range (UI-FTW-08). Non-numbers give the default. */
export function clampRightWidth(width: number): number {
  if (!Number.isFinite(width)) return RIGHT_SIDEBAR.default;
  return Math.round(Math.min(RIGHT_SIDEBAR.max, Math.max(RIGHT_SIDEBAR.min, width)));
}

/**
 * The width the right sidebar is drawn at. Below 1280 CSS px it uses its minimum, and the stored
 * width is kept for when the viewport is wider again (SET-LIFE-04).
 */
export function effectiveRightWidth(stored: number, viewportWidth: number): number {
  return viewportWidth < RIGHT_SIDEBAR.narrowViewport ? RIGHT_SIDEBAR.min : clampRightWidth(stored);
}
