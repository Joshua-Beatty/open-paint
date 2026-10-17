import type { MessageId } from "@openpaint/i18n";
import type { PropertySchema } from "@openpaint/properties";
import type { IconId } from "./common";
import type { EffectEnvironment } from "./environment";
import type { EffectRenderer } from "./render";
import type { HostServices } from "./services";

/** Where an effect appears: Effects menu, Adjustments menu, or nowhere (EXT-02-04). */
export type EffectCategory = "effect" | "adjustment" | "hidden";

/** Built-in submenu names (EXT-02-03). Registry entries may also name any other submenu. */
export const BUILTIN_EFFECT_SUBMENUS = [
  "artistic",
  "blurs",
  "color",
  "distort",
  "noise",
  "object",
  "photo",
  "render",
  "stylize",
] as const;

export type BuiltinEffectSubmenu = (typeof BUILTIN_EFFECT_SUBMENUS)[number];

/** The five effect kinds (EXT-01-01 to EXT-01-05). */
export const EFFECT_KINDS = [
  "cpuRegion",
  "cpuTile",
  "gpuImage",
  "gpuDrawing",
  "gpuLowLevel",
] as const;

export type EffectKind = (typeof EFFECT_KINDS)[number];

/** The two effect families the host recognizes (EXT-01-09). */
export type EffectFamily = "cpu" | "gpu";

export function effectFamily(kind: EffectKind): EffectFamily {
  return kind === "cpuRegion" || kind === "cpuTile" ? "cpu" : "gpu";
}

/** The color space a GPU effect computes in (FX-FW-COLOR-01). */
export type WorkingSpace = "linear" | "document";

export type AlphaMode = "premultiplied" | "straight";

/** GPU render info (EXT-02-11). Omitted fields take the host defaults. */
export interface GpuRenderOptions {
  readonly workingSpace: WorkingSpace;
  readonly inputAlpha?: AlphaMode;
  readonly outputAlpha?: AlphaMode;
  readonly inputCaching?: boolean;
}

/** Render schedules for CPU region effects (EXT-02-07). */
export const CPU_REGION_SCHEDULES = [
  "defaultCpuTiles",
  "defaultGpuTiles",
  "smallHorizontalStrips",
  "none",
  "tiles128",
  "tiles256",
  "tiles512",
  "tiles1024",
  "tiles2048",
  "tiles4096",
] as const;

/** Render schedules for CPU tile effects (EXT-02-09). */
export const CPU_TILE_SCHEDULES = ["none", "horizontalStrips", "squareTiles"] as const;

/** Render flags and schedules that the host reads before rendering (EXT-02-06 to EXT-02-09). */
export interface EffectRenderOptions {
  readonly singleThreaded?: boolean;
  /** CPU region effects: render the first tile alone unless this is set (ARC-04-02). */
  readonly firstTileWithoutBarrier?: boolean;
  /** CPU tile effects: render the first tile alone before the rest (ARC-04-02). */
  readonly firstTileWithBarrier?: boolean;
  readonly forceAliasedSelection?: boolean;
  readonly disableSelectionClipping?: boolean;
  /**
   * Keys of properties that only change the live preview, such as a diagnostic view. OK and Repeat
   * render them at their defaults, and they are never remembered, so the dialog always opens with
   * them at their defaults (FX-OBJ-ALIGN-07).
   */
  readonly previewOnlyProperties?: readonly string[];
  /**
   * Keys of properties the dialog always opens at their defaults, whatever was confirmed last. OK
   * still applies them and Repeat still re-runs the last confirmed values; they only never pre-fill
   * the dialog (FX-OBJ-ALIGN-10).
   */
  readonly openAtDefaultProperties?: readonly string[];
  /** The effect writes every pixel, so the host skips zero-filling the output (EXT-03-04). */
  readonly uninitializedOutput?: boolean;
  readonly schedule?: (typeof CPU_REGION_SCHEDULES)[number] | (typeof CPU_TILE_SCHEDULES)[number];
  readonly gpu?: GpuRenderOptions;
}

/** What the host gives an effect when it creates a renderer (EXT-03-01). */
export interface EffectInstanceHost {
  readonly services: HostServices;
  readonly environment: EffectEnvironment;
}

/**
 * Metadata, parameters and render binding of one effect (EXT-V1-05). A built-in whose renderer the
 * engine binds by `id` omits `createRenderer`.
 */
export interface EffectDescriptor {
  /** Stable identifier, unique across the registry (EXT-V1-05). */
  readonly id: string;
  /** The major API version this descriptor targets (EXT-02-13). */
  readonly apiVersion: number;
  /** Display name, used in menus, dialog titles and history entries (EXT-02-01). */
  readonly label: MessageId;
  readonly icon: IconId;
  readonly category: EffectCategory;
  /** Submenu name (EXT-02-03). Effects without one are listed after the submenus. */
  readonly submenu?: string;
  /** Whether a dialog is shown before the effect runs (EXT-02-05). */
  readonly configurable: boolean;
  readonly kind: EffectKind;
  /** Parameters, rules and layout (EXT-06). Non-configurable effects declare none. */
  readonly schema: PropertySchema;
  /**
   * Id of a bespoke editor that the UI registers for this effect (EXT-V1-02, EXT-03-03). The
   * schema still defines the parameters, and the token goes through the same preview and history.
   */
  readonly customDialog?: string;
  readonly options?: EffectRenderOptions;
  readonly createRenderer?: (host: EffectInstanceHost) => EffectRenderer;
}

/** An effect without its schema and renderer, safe to list (EXT-05-01). */
export type EffectSummary = Omit<EffectDescriptor, "createRenderer" | "schema">;
