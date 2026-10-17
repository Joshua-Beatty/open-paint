/** `GPUTextureUsage` flag values; the DOM lib types WebGPU interfaces but not these globals. */
export const TextureUsage = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
} as const;

/** `GPUBufferUsage` flag values, for the same reason as `TextureUsage`. */
export const BufferUsage = {
  MAP_READ: 0x01,
  COPY_SRC: 0x04,
  COPY_DST: 0x08,
  STORAGE: 0x80,
  UNIFORM: 0x40,
} as const;

/** Adapter limits the engine raises to the adapter's maximum and reports in diagnostics. */
export const KEY_LIMITS = [
  "maxTextureDimension2D",
  "maxBufferSize",
  "maxStorageBufferBindingSize",
  "maxComputeWorkgroupStorageSize",
] as const;

export type KeyLimit = (typeof KEY_LIMITS)[number];

/** Serializable description of a WebGPU adapter (SET-DIAG graphics section). */
export interface GpuAdapterSummary {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  isFallbackAdapter: boolean;
  features: string[];
  limits: Record<KeyLimit, number>;
}

export function summarizeAdapter(adapter: GPUAdapter): GpuAdapterSummary {
  const { vendor, architecture, device, description, isFallbackAdapter } = adapter.info;
  return {
    vendor,
    architecture,
    device,
    description,
    isFallbackAdapter: isFallbackAdapter === true,
    features: [...adapter.features].sort(),
    limits: Object.fromEntries(KEY_LIMITS.map((name) => [name, adapter.limits[name]])) as Record<
      KeyLimit,
      number
    >,
  };
}

/** Identifies an adapter for the per-adapter performance-class cache (SET-DLG-07). */
export function adapterKey(summary: GpuAdapterSummary): string {
  return [summary.vendor, summary.architecture, summary.device, summary.description].join("|");
}

/** Requests a device with the key limits raised to what the adapter supports. */
export function requestDevice(adapter: GPUAdapter): Promise<GPUDevice> {
  const requiredLimits: Record<string, number> = {};
  for (const name of KEY_LIMITS) requiredLimits[name] = adapter.limits[name];
  return adapter.requestDevice({ label: "OpenPaint engine", requiredLimits });
}
