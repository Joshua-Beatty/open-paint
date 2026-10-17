import type { EngineStatus, GpuAdapterSummary } from "@openpaint/engine";

/** The Graphics page status line (SET-DLG-07). */
export type GraphicsStatusLine =
  | { readonly kind: "active"; readonly adapter: string | undefined }
  | { readonly kind: "unavailable" }
  | { readonly kind: "off" }
  | { readonly kind: "fallback" };

/** Bit 1 of `graphics.errorFlags`: the CPU fallback after repeated device loss (SET-STO-03). */
const CPU_FALLBACK_FLAG = 1;

/**
 * The adapter's name as the status line shows it: the description or device name, with the "(TM)"
 * and "(R)" marks removed (SET-DLG-07). Undefined when the browser reports no name.
 */
export function adapterName(adapter: GpuAdapterSummary | undefined): string | undefined {
  const raw = adapter?.description || adapter?.device || adapter?.vendor || "";
  const name = raw.replace(/\s*\((?:TM|R)\)/g, "").trim();
  return name === "" ? undefined : name;
}

/** Picks the status line for the engine's state. A device-loss fallback shows its own notice. */
export function graphicsStatusLine(status: EngineStatus): GraphicsStatusLine {
  if ((status.errorFlags & CPU_FALLBACK_FLAG) !== 0 || status.reason === "device-loss") {
    return { kind: "fallback" };
  }
  if (status.backend === "webgpu") {
    return { kind: "active", adapter: adapterName(status.adapter) };
  }
  if (status.setting === "Cpu") return { kind: "off" };
  return { kind: "unavailable" };
}
