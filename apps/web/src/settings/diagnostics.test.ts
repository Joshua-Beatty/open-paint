import { createTranslator, enUS, type Translate } from "@openpaint/i18n";
import { describe, expect, it } from "vitest";
import {
  type DiagnosticsFacts,
  diagnosticGroups,
  diagnosticsText,
  megabyteText,
} from "./diagnostics";
import { workerPoolSize } from "./diagnostics-facts";

const t: Translate = createTranslator("en-US", enUS);

const facts: DiagnosticsFacts = {
  version: "1.2.3",
  now: new Date("2026-10-12T12:30:00Z"),
  sessionStart: new Date("2026-10-12T12:00:00Z"),
  installed: false,
  serviceWorkerActive: true,
  crossOriginIsolated: true,
  devicePixelRatio: 2,
  language: "en-US",
  darkScheme: true,
  animations: true,
  reducedMotion: false,
  penDetected: false,
  browserBrands: [{ brand: "Chromium", version: "130" }],
  online: true,
  deviceMemoryGb: 8,
  storage: { usage: 5 * 1024 * 1024, quota: 1024 * 1024 * 1024, persisted: true },
  logicalCores: 8,
  workerPoolSize: 6,
  wasmSimd: true,
  sharedArrayBuffer: true,
  graphics: {
    setting: "Automatic",
    backend: "webgpu",
    reason: "chosen",
    adapter: {
      vendor: "acme",
      architecture: "",
      device: "",
      description: "Acme (R)",
      isFallbackAdapter: false,
      features: ["shader-f16"],
      limits: {
        maxTextureDimension2D: 16384,
        maxBufferSize: 268435456,
        maxStorageBufferBindingSize: 134217728,
        maxComputeWorkgroupStorageSize: 32768,
      },
    },
    performanceClass: "Good",
    deviceLosses: 0,
  },
  screen: { width: 1920, height: 1080 },
  gamut: "p3",
  highDynamicRange: false,
  pointer: { fine: true, hover: true, maxTouchPoints: 0 },
  platform: {
    fileSystemAccess: true,
    launchQueue: false,
    clipboard: true,
    localFonts: false,
    keyboardLock: false,
    fullscreen: true,
    offscreenCanvas: true,
    imageDecoder: true,
  },
};

function value(label: string): string | undefined {
  for (const group of diagnosticGroups(facts, t)) {
    const item = group.items.find((entry) => entry.label === label);
    if (item !== undefined) return item.value;
  }
  return undefined;
}

describe("diagnostics report", () => {
  it("lists the groups of SET-ERR-05 in order", () => {
    expect(diagnosticGroups(facts, t).map((group) => group.title)).toEqual([
      "Application",
      "Browser",
      "Memory and storage",
      "CPU",
      "Graphics",
      "Display",
      "Pointer",
      "Platform APIs",
      "File codecs",
    ]);
  });

  it("lists the file types whose codec failed to load (FMT-REG-01)", () => {
    const none = diagnosticGroups(facts, t).at(-1);
    expect(none?.items).toEqual([{ label: "Failed to load", value: "None" }]);

    const failed: DiagnosticsFacts = {
      ...facts,
      fileCodecs: [{ name: "PNG", error: "WASM missing" }],
    };
    const items = diagnosticGroups(failed, t).at(-1)?.items;
    expect(items).toEqual([{ label: "PNG", value: "WASM missing" }]);
  });

  it("reports the build date, the update status and the last check (SET-ERR-05)", () => {
    const known: DiagnosticsFacts = {
      ...facts,
      buildDate: "2026-10-13T08:00:00.000Z",
      update: { state: "upToDate", lastCheck: new Date("2026-10-13T09:00:00.000Z") },
    };
    const notChecked: DiagnosticsFacts = {
      ...facts,
      update: { state: "idle", lastCheck: undefined },
    };
    const items = (report: DiagnosticsFacts) =>
      diagnosticGroups(report, t)[0]?.items.map((item) => [item.label, item.value]);

    expect(items(known)).toContainEqual(["Build date", "2026-10-13T08:00:00.000Z"]);
    expect(items(known)).toContainEqual(["Update status", "Up to date"]);
    expect(items(known)).toContainEqual(["Last update check", "2026-10-13T09:00:00.000Z"]);
    expect(items(notChecked)).toContainEqual(["Update status", "Not checked yet"]);
    expect(items(notChecked)).toContainEqual(["Last update check", "Never"]);
    expect(items(facts)?.map(([label]) => label)).not.toContain("Build date");
  });

  it("reports the graphics backend, its adapter and the device limits", () => {
    expect(value("Active backend")).toBe("WebGPU");
    expect(value("Adapter")).toBe("Acme");
    expect(value("Max texture dimension")).toBe("16384");
    expect(value("GPU performance class")).toBe("Good");
  });

  it("reports storage in megabytes and whether it is persistent", () => {
    expect(value("Storage usage")).toBe("5 MB");
    expect(value("Storage quota")).toBe("1024 MB");
    expect(value("Persistent storage")).toBe("Yes");
  });

  it("marks what the browser does not report as unknown", () => {
    const partial = {
      ...facts,
      graphics: undefined,
      storage: undefined,
      deviceMemoryGb: undefined,
    };
    const groups = diagnosticGroups(partial, t);
    const items = groups.flatMap((group) => group.items);
    expect(items.find((item) => item.label === "Active backend")?.value).toBe("Unknown");
    expect(items.find((item) => item.label === "Device memory")?.value).toBe("Unknown");
    expect(items.find((item) => item.label === "Storage usage")?.value).toBe("Unknown");
  });

  it("copies the report as header, group titles and label lines", () => {
    const text = diagnosticsText(diagnosticGroups(facts, t), "OpenPaint 1.2.3");
    const lines = text.split("\n");
    expect(lines[0]).toBe("OpenPaint 1.2.3");
    expect(lines).toContain("Graphics");
    expect(lines).toContain("  Active backend: WebGPU");
    expect(text.endsWith("\n")).toBe(false);
  });

  it("formats byte counts in megabytes", () => {
    expect(megabyteText(t, 1024 * 1024 * 1.5)).toBe("1.5 MB");
  });
});

describe("worker pool sizing (SET-STO-03)", () => {
  it("follows each policy and never drops below one worker", () => {
    expect(workerPoolSize("ThreeQuarters", 8)).toBe(6);
    expect(workerPoolSize("AllButOne", 8)).toBe(7);
    expect(workerPoolSize("All", 8)).toBe(8);
    expect(workerPoolSize("Single", 8)).toBe(1);
    expect(workerPoolSize("ThreeQuarters", 1)).toBe(1);
    expect(workerPoolSize("AllButOne", 1)).toBe(1);
  });
});
