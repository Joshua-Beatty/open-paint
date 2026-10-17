import type { BackendReason, GpuAdapterSummary } from "@openpaint/engine";
import type { MessageId, Translate } from "@openpaint/i18n";
import type { UpdateState } from "../help/updates";
import { adapterName } from "./graphics-status";

/** The platform APIs the report lists (SET-ERR-05 "Platform APIs"). */
export interface PlatformApis {
  readonly fileSystemAccess: boolean;
  readonly launchQueue: boolean;
  readonly clipboard: boolean;
  readonly localFonts: boolean;
  readonly keyboardLock: boolean;
  readonly fullscreen: boolean;
  readonly offscreenCanvas: boolean;
  readonly imageDecoder: boolean;
}

/** Facts about the running app, gathered from the browser and the engine (SET-ERR-05). */
export interface DiagnosticsFacts {
  readonly version: string;
  /** When this build was made, as an ISO 8601 string. */
  readonly buildDate?: string;
  /** The update state and the last check (SET-UPD-04, SET-ERR-05), when the app has an update controller. */
  readonly update?: UpdateFacts;
  readonly now: Date;
  readonly sessionStart: Date;
  readonly installed: boolean;
  readonly serviceWorkerActive: boolean;
  readonly crossOriginIsolated: boolean;
  readonly devicePixelRatio: number;
  readonly language: string;
  readonly darkScheme: boolean;
  readonly animations: boolean;
  readonly reducedMotion: boolean;
  readonly penDetected: boolean;
  readonly browserBrands: readonly { readonly brand: string; readonly version: string }[];
  readonly online: boolean;
  readonly deviceMemoryGb?: number;
  readonly heapUsedBytes?: number;
  readonly storage?: {
    readonly usage: number;
    readonly quota: number;
    readonly persisted?: boolean;
  };
  readonly logicalCores: number;
  readonly workerPoolSize: number;
  readonly wasmSimd: boolean;
  readonly sharedArrayBuffer: boolean;
  readonly graphics?: GraphicsFacts;
  readonly screen: { readonly width: number; readonly height: number };
  readonly gamut?: "srgb" | "p3" | "rec2020";
  readonly highDynamicRange: boolean;
  readonly pointer: {
    readonly fine: boolean;
    readonly hover: boolean;
    readonly maxTouchPoints: number;
  };
  readonly platform: PlatformApis;
  /** The file types whose codec failed to load in this session (FMT-REG-01). */
  readonly fileCodecs?: readonly FileCodecFact[];
}

/** A file type whose codec failed to load, and the codec's error (FMT-REG-01). */
export interface FileCodecFact {
  readonly name: string;
  readonly error: string;
}

/** The update state and the time of the last check (SET-ERR-05). */
export interface UpdateFacts {
  readonly state: UpdateState;
  readonly lastCheck: Date | undefined;
}

/** What the engine reports about the active rendering backend (SET-DLG-07, SET-ERR-05). */
export interface GraphicsFacts {
  readonly setting: string;
  readonly backend: "webgpu" | "cpu";
  readonly reason: BackendReason;
  readonly adapter?: GpuAdapterSummary;
  readonly performanceClass: "VeryLow" | "Low" | "Good";
  readonly deviceLosses: number;
}

export interface DiagnosticItem {
  readonly label: string;
  readonly value: string;
}

export interface DiagnosticGroup {
  readonly title: string;
  readonly items: readonly DiagnosticItem[];
}

const MEGABYTE = 1024 * 1024;
const MINUTE = 60_000;

function yesNo(t: Translate, value: boolean): string {
  return t(value ? "settings.value.yes" : "settings.value.no");
}

/** A byte count in megabytes, as the report and the storage line show it. */
export function megabyteText(t: Translate, bytes: number): string {
  return t("settings.value.megabytes", { count: Math.round((bytes / MEGABYTE) * 10) / 10 });
}

function reasonText(t: Translate, reason: BackendReason): string {
  const keys: Record<BackendReason, MessageId> = {
    chosen: "settings.value.chosen",
    "turned-off": "settings.value.turnedOff",
    unavailable: "settings.value.unavailableReason",
    "software-adapter": "settings.value.softwareAdapter",
    "device-loss": "settings.value.deviceLoss",
  };
  return t(keys[reason]);
}

function performanceText(
  t: Translate,
  performanceClass: GraphicsFacts["performanceClass"],
): string {
  const keys: Record<GraphicsFacts["performanceClass"], MessageId> = {
    VeryLow: "settings.value.performanceVeryLow",
    Low: "settings.value.performanceLow",
    Good: "settings.value.performanceGood",
  };
  return t(keys[performanceClass]);
}

const UPDATE_STATE_KEYS: Record<UpdateState, MessageId> = {
  idle: "settings.diagnostics.updateState.idle",
  checking: "settings.diagnostics.updateState.checking",
  upToDate: "settings.diagnostics.updateState.upToDate",
  updateAvailable: "settings.diagnostics.updateState.updateAvailable",
  error: "settings.diagnostics.updateState.error",
  offline: "settings.diagnostics.updateState.offline",
};

function applicationGroup(facts: DiagnosticsFacts, t: Translate): DiagnosticGroup {
  const uptimeMinutes = Math.max(
    0,
    Math.floor((facts.now.getTime() - facts.sessionStart.getTime()) / MINUTE),
  );
  const updateItems: DiagnosticItem[] =
    facts.update === undefined
      ? []
      : [
          {
            label: t("settings.diagnostics.item.updateStatus"),
            value: t(UPDATE_STATE_KEYS[facts.update.state]),
          },
          {
            label: t("settings.diagnostics.item.lastUpdateCheck"),
            value:
              facts.update.lastCheck === undefined
                ? t("settings.value.never")
                : facts.update.lastCheck.toISOString(),
          },
        ];
  return {
    title: t("settings.diagnostics.group.application"),
    items: [
      { label: t("settings.diagnostics.item.version"), value: facts.version },
      ...(facts.buildDate === undefined
        ? []
        : [{ label: t("settings.diagnostics.item.buildDate"), value: facts.buildDate }]),
      { label: t("settings.diagnostics.item.time"), value: facts.now.toISOString() },
      {
        label: t("settings.diagnostics.item.uptime"),
        value: t("settings.value.uptime", { minutes: uptimeMinutes }),
      },
      {
        label: t("settings.diagnostics.item.runMode"),
        value: t(facts.installed ? "settings.value.installedApp" : "settings.value.browserTab"),
      },
      {
        label: t("settings.diagnostics.item.serviceWorker"),
        value: t(
          facts.serviceWorkerActive ? "settings.value.available" : "settings.value.unavailable",
        ),
      },
      {
        label: t("settings.diagnostics.item.crossOrigin"),
        value: yesNo(t, facts.crossOriginIsolated),
      },
      {
        label: t("settings.diagnostics.item.uiScale"),
        value: t("settings.value.dpr", { scale: facts.devicePixelRatio }),
      },
      { label: t("settings.diagnostics.item.language"), value: facts.language },
      {
        label: t("settings.diagnostics.item.theme"),
        value: t(facts.darkScheme ? "settings.option.dark" : "settings.option.light"),
      },
      {
        label: t("settings.diagnostics.item.animations"),
        value: t(facts.animations ? "settings.value.on" : "settings.value.off"),
      },
      {
        label: t("settings.diagnostics.item.reducedMotion"),
        value: yesNo(t, facts.reducedMotion),
      },
      {
        label: t("settings.diagnostics.item.penInput"),
        value: yesNo(t, facts.penDetected),
      },
      ...updateItems,
    ],
  };
}

function browserGroup(facts: DiagnosticsFacts, t: Translate): DiagnosticGroup {
  const brands = facts.browserBrands.map((entry) => `${entry.brand} ${entry.version}`).join(", ");
  return {
    title: t("settings.diagnostics.group.browser"),
    items: [
      {
        label: t("settings.diagnostics.item.browser"),
        value: brands === "" ? t("settings.value.unknown") : brands,
      },
      { label: t("settings.diagnostics.item.online"), value: yesNo(t, facts.online) },
    ],
  };
}

function memoryGroup(facts: DiagnosticsFacts, t: Translate): DiagnosticGroup {
  const unknown = t("settings.value.unknown");
  const storage = facts.storage;
  const persisted = storage?.persisted === undefined ? unknown : yesNo(t, storage.persisted);
  return {
    title: t("settings.diagnostics.group.memory"),
    items: [
      {
        label: t("settings.diagnostics.item.deviceMemory"),
        value:
          facts.deviceMemoryGb === undefined
            ? unknown
            : t("settings.value.gigabytes", { count: facts.deviceMemoryGb }),
      },
      {
        label: t("settings.diagnostics.item.heap"),
        value: facts.heapUsedBytes === undefined ? unknown : megabyteText(t, facts.heapUsedBytes),
      },
      {
        label: t("settings.diagnostics.item.storageUsage"),
        value: storage === undefined ? unknown : megabyteText(t, storage.usage),
      },
      {
        label: t("settings.diagnostics.item.storageQuota"),
        value: storage === undefined ? unknown : megabyteText(t, storage.quota),
      },
      { label: t("settings.diagnostics.item.persistent"), value: persisted },
    ],
  };
}

function cpuGroup(facts: DiagnosticsFacts, t: Translate): DiagnosticGroup {
  return {
    title: t("settings.diagnostics.group.cpu"),
    items: [
      { label: t("settings.diagnostics.item.cores"), value: String(facts.logicalCores) },
      { label: t("settings.diagnostics.item.workers"), value: String(facts.workerPoolSize) },
      { label: t("settings.diagnostics.item.wasmSimd"), value: yesNo(t, facts.wasmSimd) },
      {
        label: t("settings.diagnostics.item.threads"),
        value: yesNo(t, facts.sharedArrayBuffer),
      },
    ],
  };
}

function graphicsGroup(facts: DiagnosticsFacts, t: Translate): DiagnosticGroup {
  const unknown = t("settings.value.unknown");
  const graphics = facts.graphics;
  if (graphics === undefined) {
    return {
      title: t("settings.diagnostics.group.graphics"),
      items: [{ label: t("settings.diagnostics.item.backend"), value: unknown }],
    };
  }
  const adapter = graphics.adapter;
  const features = adapter?.features ?? [];
  return {
    title: t("settings.diagnostics.group.graphics"),
    items: [
      {
        label: t("settings.diagnostics.item.backend"),
        value: t(
          graphics.backend === "webgpu"
            ? "settings.value.webgpuBackend"
            : "settings.value.cpuBackend",
        ),
      },
      { label: t("settings.diagnostics.item.reason"), value: reasonText(t, graphics.reason) },
      {
        label: t("settings.diagnostics.item.adapter"),
        value: adapterName(adapter) ?? t("settings.value.none"),
      },
      {
        label: t("settings.diagnostics.item.fallbackAdapter"),
        value: adapter === undefined ? unknown : yesNo(t, adapter.isFallbackAdapter),
      },
      {
        label: t("settings.diagnostics.item.features"),
        value: features.length === 0 ? t("settings.value.none") : features.join(", "),
      },
      {
        label: t("settings.diagnostics.item.maxTexture"),
        value: String(adapter?.limits.maxTextureDimension2D ?? unknown),
      },
      {
        label: t("settings.diagnostics.item.maxBuffer"),
        value: String(adapter?.limits.maxBufferSize ?? unknown),
      },
      {
        label: t("settings.diagnostics.item.maxStorageBinding"),
        value: String(adapter?.limits.maxStorageBufferBindingSize ?? unknown),
      },
      {
        label: t("settings.diagnostics.item.maxWorkgroupStorage"),
        value: String(adapter?.limits.maxComputeWorkgroupStorageSize ?? unknown),
      },
      {
        label: t("settings.diagnostics.item.performanceClass"),
        value: performanceText(t, graphics.performanceClass),
      },
      {
        label: t("settings.diagnostics.item.deviceLosses"),
        value: String(graphics.deviceLosses),
      },
    ],
  };
}

function displayGroup(facts: DiagnosticsFacts, t: Translate): DiagnosticGroup {
  const gamutKeys = {
    srgb: "settings.value.gamutSrgb",
    p3: "settings.value.gamutP3",
    rec2020: "settings.value.gamutRec2020",
  } as const;
  return {
    title: t("settings.diagnostics.group.display"),
    items: [
      {
        label: t("settings.diagnostics.item.screen"),
        value: t("settings.value.screen", {
          width: facts.screen.width,
          height: facts.screen.height,
        }),
      },
      {
        label: t("settings.diagnostics.item.gamut"),
        value: facts.gamut === undefined ? t("settings.value.unknown") : t(gamutKeys[facts.gamut]),
      },
      {
        label: t("settings.diagnostics.item.dynamicRange"),
        value: t(facts.highDynamicRange ? "settings.value.high" : "settings.value.standard"),
      },
      {
        label: t("settings.diagnostics.item.canvasColorSpace"),
        value: t("settings.value.srgb"),
      },
    ],
  };
}

function pointerGroup(facts: DiagnosticsFacts, t: Translate): DiagnosticGroup {
  return {
    title: t("settings.diagnostics.group.pointer"),
    items: [
      {
        label: t("settings.diagnostics.item.pointer"),
        value: t(facts.pointer.fine ? "settings.value.fine" : "settings.value.coarse"),
      },
      {
        label: t("settings.diagnostics.item.hover"),
        value: t(facts.pointer.hover ? "settings.value.hover" : "settings.value.noHover"),
      },
      {
        label: t("settings.diagnostics.item.touchPoints"),
        value: String(facts.pointer.maxTouchPoints),
      },
      {
        label: t("settings.diagnostics.item.penDetected"),
        value: yesNo(t, facts.penDetected),
      },
    ],
  };
}

function platformGroup(facts: DiagnosticsFacts, t: Translate): DiagnosticGroup {
  const apis: readonly [keyof PlatformApis, MessageId][] = [
    ["fileSystemAccess", "settings.diagnostics.item.fileSystemAccess"],
    ["launchQueue", "settings.diagnostics.item.launchQueue"],
    ["clipboard", "settings.diagnostics.item.clipboard"],
    ["localFonts", "settings.diagnostics.item.localFonts"],
    ["keyboardLock", "settings.diagnostics.item.keyboardLock"],
    ["fullscreen", "settings.diagnostics.item.fullscreen"],
    ["offscreenCanvas", "settings.diagnostics.item.offscreenCanvas"],
    ["imageDecoder", "settings.diagnostics.item.imageDecoder"],
  ];
  return {
    title: t("settings.diagnostics.group.platform"),
    items: apis.map(([name, label]) => ({
      label: t(label),
      value: t(facts.platform[name] ? "settings.value.available" : "settings.value.unavailable"),
    })),
  };
}

/** A file type whose codec failed to load this session (FMT-REG-01). */
function fileCodecsGroup(facts: DiagnosticsFacts, t: Translate): DiagnosticGroup {
  const failed = facts.fileCodecs ?? [];
  return {
    title: t("settings.diagnostics.group.fileCodecs"),
    items:
      failed.length === 0
        ? [{ label: t("settings.diagnostics.item.codecsFailed"), value: t("settings.value.none") }]
        : failed.map((codec) => ({ label: codec.name, value: codec.error })),
  };
}

/** The diagnostics report, grouped as SET-ERR-05 lists it. The page and the copied text share it. */
export function diagnosticGroups(facts: DiagnosticsFacts, t: Translate): DiagnosticGroup[] {
  return [
    applicationGroup(facts, t),
    browserGroup(facts, t),
    memoryGroup(facts, t),
    cpuGroup(facts, t),
    graphicsGroup(facts, t),
    displayGroup(facts, t),
    pointerGroup(facts, t),
    platformGroup(facts, t),
    fileCodecsGroup(facts, t),
  ];
}

/**
 * The report as plain text for the clipboard: the header line, then a title line per group and a
 * `label: value` line per item.
 */
export function diagnosticsText(groups: readonly DiagnosticGroup[], header: string): string {
  const lines = groups.flatMap((group) => [
    group.title,
    ...group.items.map((item) => `  ${item.label}: ${item.value}`),
    "",
  ]);
  return [header, "", ...lines].join("\n").trimEnd();
}
