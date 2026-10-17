// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { DecodeError } from "@openpaint/codecs";
import initWasm from "@openpaint/cpu";
import { DEFAULT_RESOLUTION, Document, OutOfMemoryError, Surface } from "@openpaint/document";
import {
  EXTENSION_API_MAJOR,
  type FileCodec,
  type FileDocument,
  type FileTypeDescriptor,
  FileTypeRegistry,
} from "@openpaint/extension-api";
import { createTranslator, enUS } from "@openpaint/i18n";
import type { PropertyValues } from "@openpaint/properties";
import { MemoryRecentFilesBackend, RecentFiles } from "@openpaint/storage";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Printer, PrintJob } from "../print/print-job";
import { ImageTabs } from "../tabs/image-tabs";
import type { OpenImage } from "../tabs/open-image";
import type { FileAccess, OpenedFile, PickerType, SaveTarget } from "./file-access";
import { type FileDialogRequest, FileDialogs } from "./file-dialogs";
import { documentFromFile, FileFlows, flatFileDocument, layeredFileDocument } from "./file-flows";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const t = createTranslator("en-US", enUS);

/**
 * A toy format for the tests: one width byte, one height byte, then the RGBA pixels. Its codec
 * writes the header and the pixels as two chunks, so the flow's joining of chunks is exercised.
 */
const rawCodec: FileCodec = {
  async load(source) {
    const bytes = await source.readAll();
    const width = bytes[0] ?? 0;
    const height = bytes[1] ?? 0;
    if (bytes.length !== 2 + width * height * 4) throw new DecodeError("Bad raw data.");
    const surface = new Surface(width, height, new Uint8ClampedArray(bytes.subarray(2)));
    return rawFile(surface);
  },
  async save(file, sink) {
    const layer = file.layers[0];
    if (layer === undefined) throw new RangeError("No layer.");
    await sink.write(Uint8Array.of(file.width, file.height));
    await sink.write(new Uint8Array(layer.surface.data));
  },
};

function rawFile(surface: Surface): FileDocument {
  return {
    width: surface.width,
    height: surface.height,
    resolution: DEFAULT_RESOLUTION,
    colorProfile: "srgb",
    metadata: { xmp: [], user: {} },
    layers: [{ name: "Background", visible: true, opacity: 255, blendMode: 0, surface }],
  };
}

function rawType(overrides: Partial<FileTypeDescriptor> = {}): FileTypeDescriptor {
  return {
    id: "raw",
    apiVersion: EXTENSION_API_MAJOR,
    label: "fileType.png",
    icon: "file-raw",
    loadExtensions: [".raw"],
    saveExtensions: [".raw"],
    mimeTypes: ["application/x-raw"],
    capabilities: {
      supportsLayers: false,
      supportsCustomHeaders: false,
      supportsSaving: true,
      supportsLoading: true,
      savesWithProgress: false,
      supportsCancellation: false,
    },
    saveOptions: { properties: [] },
    loadCodec: async () => rawCodec,
    isLossless: () => true,
    ...overrides,
  };
}

/** A format with one option. Its first byte records whether "Remove metadata" was on. */
const optionCodec: FileCodec = {
  load: rawCodec.load,
  async save(file, sink, token) {
    const layer = file.layers[0];
    if (layer === undefined) throw new RangeError("No layer.");
    await sink.write(Uint8Array.of(token.removeMetadata === true ? 1 : 0, file.width, file.height));
    await sink.write(new Uint8Array(layer.surface.data));
  },
};

function optionType(): FileTypeDescriptor {
  return rawType({
    id: "cfg",
    loadExtensions: [".cfg"],
    saveExtensions: [".cfg"],
    loadCodec: async () => optionCodec,
    saveOptions: {
      properties: [
        {
          kind: "boolean",
          key: "removeMetadata",
          label: "fileOption.removeMetadata",
          defaultValue: false,
        },
      ],
    },
  });
}

function rawBytes(width: number, height: number, value = 7): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(2 + width * height * 4));
  bytes[0] = width;
  bytes[1] = height;
  bytes.fill(value, 2);
  return bytes;
}

function handle(name: string): FileSystemFileHandle {
  return { name } as unknown as FileSystemFileHandle;
}

/** The file access of the tests: picks what the test sets and records every write. */
class FakeAccess implements FileAccess {
  canPickSaveTarget = true;
  opened: OpenedFile[] = [];
  saveTarget: SaveTarget | undefined;
  writeError: unknown;
  openError: unknown;
  readonly pickerCalls: PickerType[][] = [];
  readonly suggestions: string[] = [];
  readonly written: { readonly handle: FileSystemFileHandle; readonly bytes: Uint8Array }[] = [];
  readonly downloads: { readonly name: string; readonly bytes: Uint8Array }[] = [];

  async pickFiles(types: readonly PickerType[]): Promise<readonly OpenedFile[]> {
    this.pickerCalls.push([...types]);
    return this.opened;
  }

  async pickSaveTarget(suggestedName: string): Promise<SaveTarget | undefined> {
    this.suggestions.push(suggestedName);
    return this.saveTarget;
  }

  async openHandle(stored: FileSystemFileHandle): Promise<OpenedFile> {
    if (this.openError !== undefined) throw this.openError;
    return { name: stored.name, handle: stored, bytes: async () => rawBytes(2, 2) };
  }

  async ensureWritable(): Promise<void> {}

  async write(target: FileSystemFileHandle, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    if (this.writeError !== undefined) throw this.writeError;
    this.written.push({ handle: target, bytes });
  }

  download(name: string, _mimeType: string, bytes: Uint8Array<ArrayBuffer>): void {
    this.downloads.push({ name, bytes });
  }
}

/** A layered file whose one layer could not be read, as the native reader reports it (FMT-NAT-09). */
function damagedType(): FileTypeDescriptor {
  return rawType({
    id: "damaged",
    loadExtensions: [".dmg"],
    loadCodec: async () => ({
      async load(source) {
        await source.readAll();
        return {
          width: 1,
          height: 1,
          resolution: DEFAULT_RESOLUTION,
          colorProfile: "srgb",
          metadata: { xmp: [], user: {} },
          layers: [
            {
              name: "Background",
              visible: true,
              opacity: 255,
              blendMode: 0,
              surface: new Surface(1, 1, new Uint8ClampedArray(4)),
              isBackground: true,
              damaged: true,
            },
          ],
          dirty: true,
        };
      },
      async save() {},
    }),
  });
}

function harness(types: readonly FileTypeDescriptor[] = [rawType()]) {
  const registry = new FileTypeRegistry();
  for (const type of types) registry.register(type);
  const access = new FakeAccess();
  const printer = new FakePrinter();
  const dialogs = new FileDialogs();
  const recent = new RecentFiles(new MemoryRecentFilesBackend());
  const tabs = new ImageTabs<OpenImage>();
  const notes: string[] = [];
  const reports: unknown[] = [];
  const savedConfig = new Map<string, PropertyValues>();
  const flows = new FileFlows({
    registry,
    access,
    dialogs,
    recent,
    saveConfig: {
      load: (typeId) => savedConfig.get(typeId),
      store: (typeId, values) => {
        savedConfig.set(typeId, values);
      },
    },
    tabs,
    t,
    openImage: (image) => tabs.open(image),
    thumbnail: () => "data:image/png;base64,AAAA",
    devicePixelRatio: () => 2,
    printer,
    newImageSize: () => ({ width: 8, height: 6 }),
    notify: (text) => notes.push(text),
    report: (cause) => reports.push(cause),
  });
  return { flows, access, dialogs, recent, tabs, notes, reports, savedConfig, printer };
}

/** The browser's printing: it records each job and can be made to lack print or fail to encode. */
class FakePrinter implements Printer {
  supported = true;
  encoded: string | undefined = "data:image/png;base64,PRINT";
  encodeError: unknown;
  readonly jobs: PrintJob[] = [];

  available(): boolean {
    return this.supported;
  }

  encode(): string | undefined {
    if (this.encodeError !== undefined) throw this.encodeError;
    return this.encoded;
  }

  async print(job: PrintJob): Promise<void> {
    this.jobs.push(job);
  }
}

/** Waits until the flow shows the dialog of this kind, then returns it to answer. */
async function dialogOf<K extends FileDialogRequest["kind"]>(dialogs: FileDialogs, kind: K) {
  await vi.waitFor(() => {
    expect(dialogs.request?.kind).toBe(kind);
  });
  return dialogs.request as Extract<FileDialogRequest, { kind: K }>;
}

/** A clean image with one edit, so it counts as unsaved. */
function dirtyDocument(width = 2, height = 2): Document {
  const doc = Document.fromSurface(
    new Surface(width, height, new Uint8ClampedArray(width * height * 4).fill(255)),
  );
  doc.setActiveLayerProperties({ opacity: 200 });
  return doc;
}

describe("documentFromFile (FMT-OPEN-01)", () => {
  it("makes a clean document from the one layer", () => {
    const doc = documentFromFile(rawFile(new Surface(3, 1, new Uint8ClampedArray(12).fill(9))));
    expect(doc.width).toBe(3);
    expect(doc.height).toBe(1);
    expect(doc.dirty).toBe(false);
    expect(doc.layerCount).toBe(1);
  });

  it("keeps every layer, the selection, the active layer and unknown keys of a layered file", () => {
    const surface = () => new Surface(2, 1, new Uint8ClampedArray(8));
    const layer = (name: string, isBackground: boolean) => ({
      name,
      visible: true,
      opacity: 255,
      blendMode: 0,
      surface: surface(),
      isBackground,
    });
    const doc = documentFromFile({
      width: 2,
      height: 1,
      resolution: DEFAULT_RESOLUTION,
      colorProfile: "srgb",
      metadata: { xmp: [], user: {} },
      layers: [layer("Back", true), layer("Top", false)],
      activeLayer: 0,
      selection: { polygons: [[0, 0, 2, 0, 2, 1, 0, 1]], quality: "aliased" },
      extras: { document: { "x-future": 1 } },
      dirty: true,
    });
    expect(doc.layers.map((item) => item.name)).toEqual(["Back", "Top"]);
    expect(doc.activeLayer).toBe(doc.layers[0]);
    expect(doc.selection.quality).toBe("aliased");
    expect(doc.selection.isEmpty).toBe(false);
    expect(doc.formatExtras).toEqual({ document: { "x-future": 1 } });
    expect(doc.dirty).toBe(true);

    const written = layeredFileDocument(doc);
    expect(written.layers.map((item) => item.name)).toEqual(["Back", "Top"]);
    expect(written.layers[0]?.isBackground).toBe(true);
    expect(written.activeLayer).toBe(0);
    expect(written.selection?.quality).toBe("aliased");
    expect(written.extras).toEqual({ document: { "x-future": 1 } });
    expect(written.thumbnail?.width).toBe(2);
  });

  it("keeps EXIF, XMP, IPTC and user metadata from open to the flat file it saves", () => {
    const exif = new Uint8Array([0x49, 0x49, 0x2a, 0x00]);
    const iptc = new Uint8Array([0x1c, 0x02, 0x05, 0x41]);
    const file = rawFile(new Surface(1, 1, new Uint8ClampedArray(4)));
    const doc = documentFromFile({
      ...file,
      metadata: { exif, xmp: ["<x:xmpmeta/>"], iptc, user: { Title: "Kept" } },
    });
    const saved = flatFileDocument(doc).metadata;
    expect(saved.exif).toEqual(exif);
    expect(saved.xmp).toEqual(["<x:xmpmeta/>"]);
    expect(saved.iptc).toEqual(iptc);
    expect(saved.user).toEqual({ Title: "Kept" });
  });

  it("writes no IPTC or user items for a document that has none", () => {
    const doc = documentFromFile(rawFile(new Surface(1, 1, new Uint8ClampedArray(4))));
    expect(flatFileDocument(doc).metadata).toEqual({ xmp: [], user: {} });
  });
});

describe("Open (FMT-OPEN-01..03)", () => {
  it("offers the loadable types in the picker and opens each picked file as a tab", async () => {
    const { flows, access, tabs, recent, dialogs } = harness();
    access.opened = [{ name: "pic.raw", bytes: async () => rawBytes(2, 2) }];

    await flows.openFiles();

    expect(access.pickerCalls[0]?.map((type) => type.description)).toEqual([
      "All image types",
      "PNG",
      "All Files",
    ]);
    expect(access.pickerCalls[0]?.[0]?.extensions).toEqual([".raw"]);
    const [image] = tabs.state.items;
    expect(image?.value.name).toBe("pic.raw");
    expect(image?.value.file?.typeId).toBe("raw");
    expect(image?.value.document.width).toBe(2);
    expect(recent.entries[0]?.name).toBe("pic.raw");
    expect(recent.entries[0]?.thumbnail).toBe("data:image/png;base64,AAAA");
    expect(recent.entries[0]?.thumbnailScale).toBe(2);
    expect(dialogs.request).toBeUndefined();
  });

  it("opens an image and then shows the warnings its load raised (FMT-META-03)", async () => {
    const warned = rawType({
      id: "warned",
      loadExtensions: [".warn"],
      loadCodec: async () => ({
        async load(source) {
          await source.readAll();
          return { ...rawFile(new Surface(1, 1)), warnings: ["file.warning.profileIgnored"] };
        },
        async save() {},
      }),
    });
    const { flows, access, tabs, notes, reports } = harness([warned]);
    access.opened = [{ name: "pic.warn", bytes: async () => rawBytes(1, 1) }];

    await flows.openFiles();
    expect(reports).toEqual([]);

    expect(tabs.state.items.map((item) => item.value.name)).toEqual(["pic.warn"]);
    expect(notes).toEqual([t("file.warning.profileIgnored")]);
  });

  it("asks before opening a file with damaged layers, and opens nothing when declined (FMT-NAT-09)", async () => {
    const { flows, access, tabs, dialogs } = harness([damagedType()]);
    access.opened = [{ name: "pic.dmg", bytes: async () => rawBytes(1, 1) }];

    const done = flows.openFiles();
    (await dialogOf(dialogs, "recoverLayers")).answer(false);
    await done;

    expect(tabs.count).toBe(0);
    expect(dialogs.request).toBeUndefined();
  });

  it("opens a file with damaged layers, blank, when the user agrees (FMT-NAT-09)", async () => {
    const { flows, access, tabs, dialogs } = harness([damagedType()]);
    access.opened = [{ name: "pic.dmg", bytes: async () => rawBytes(1, 1) }];

    const done = flows.openFiles();
    (await dialogOf(dialogs, "recoverLayers")).answer(true);
    await done;

    expect(tabs.state.items.map((item) => item.value.name)).toEqual(["pic.dmg"]);
    expect(tabs.state.items[0]?.value.document.dirty).toBe(true);
  });

  it("asks Retry, Skip or Cancel when a file has an unknown extension, then skips it", async () => {
    const { flows, access, tabs, dialogs, reports } = harness();
    access.opened = [{ name: "notes.xyz", bytes: async () => rawBytes(1, 1) }];

    const done = flows.openFiles();
    const failed = await dialogOf(dialogs, "transferError");
    expect(failed.message).toBe(
      "There was an error transferring the image:\n\nThe image type is not recognized, and cannot be opened.",
    );
    failed.answer("skip");
    await done;

    expect(tabs.count).toBe(0);
    expect(reports).toEqual([]);
    expect(dialogs.request).toBeUndefined();
  });

  it("retries the same file when the user chooses Retry", async () => {
    const { flows, access, tabs, dialogs } = harness();
    let attempts = 0;
    access.opened = [
      {
        name: "flaky.raw",
        bytes: async () => {
          attempts += 1;
          return attempts === 1 ? new Uint8Array([2, 2, 1]) : rawBytes(2, 2);
        },
      },
    ];

    const done = flows.openFiles();
    const failed = await dialogOf(dialogs, "transferError");
    expect(failed.message).toContain("There was an error opening the file.");
    failed.answer("retry");
    await done;

    expect(attempts).toBe(2);
    expect(tabs.count).toBe(1);
  });

  it("stops after Cancel and does not try the remaining files", async () => {
    const { flows, access, tabs, dialogs } = harness();
    const later = vi.fn(async () => rawBytes(1, 1));
    access.opened = [
      { name: "bad.raw", bytes: async () => new Uint8Array([9, 9]) },
      { name: "good.raw", bytes: later },
    ];

    const done = flows.openFiles();
    (await dialogOf(dialogs, "transferError")).answer("cancel");
    await done;

    expect(later).not.toHaveBeenCalled();
    expect(tabs.count).toBe(0);
  });

  it("opens the files that are good when the others are skipped", async () => {
    const { flows, access, tabs, dialogs } = harness();
    access.opened = [
      { name: "bad.raw", bytes: async () => new Uint8Array([9, 9]) },
      { name: "good.raw", bytes: async () => rawBytes(1, 1) },
    ];

    const done = flows.openFiles();
    (await dialogOf(dialogs, "transferError")).answer("skip");
    await done;

    expect(tabs.state.items.map((item) => item.value.name)).toEqual(["good.raw"]);
  });

  it("reports a codec that fails to load and leaves its type out of the pickers", async () => {
    const broken = rawType({
      id: "broken",
      loadExtensions: [".broken"],
      saveExtensions: [],
      capabilities: {
        supportsLayers: false,
        supportsCustomHeaders: false,
        supportsSaving: false,
        supportsLoading: true,
        savesWithProgress: false,
        supportsCancellation: false,
      },
      loadCodec: async () => {
        throw new Error("WASM missing");
      },
    });
    const { flows, access, dialogs } = harness([rawType(), broken]);
    access.opened = [{ name: "x.broken", bytes: async () => rawBytes(1, 1) }];

    const done = flows.openFiles();
    const failed = await dialogOf(dialogs, "transferError");
    expect(failed.message).toContain(
      "Working with this file type requires a codec that could not be loaded: WASM missing",
    );
    failed.answer("skip");
    await done;

    access.opened = [];
    await flows.openFiles();
    const offered = access.pickerCalls[1]?.[0]?.extensions ?? [];
    expect(offered).toEqual([".raw"]);
    expect(flows.unavailableCodecs()).toEqual([{ name: "PNG", error: "WASM missing" }]);
  });
});

describe("Content sniffing (FMT-OPEN-02)", () => {
  /** Two bytes that the toy raw format's header also matches: width 2, height 2. */
  const sniffsRaw = (bytes: Uint8Array) => bytes[0] === 2 && bytes[1] === 2;

  it("opens a file with an unknown extension by its content", async () => {
    const { flows, access, tabs, dialogs } = harness([rawType({ sniff: sniffsRaw })]);
    access.opened = [{ name: "scan.unknown", bytes: async () => rawBytes(2, 2) }];

    await flows.openFiles();

    expect(dialogs.request).toBeUndefined();
    expect(tabs.state.items.map((item) => item.value.name)).toEqual(["scan.unknown"]);
    expect(tabs.state.items[0]?.value.file?.typeId).toBe("raw");
  });

  it("opens with the type the content matches when the declared type cannot decode it", async () => {
    const declaredButWrong = rawType({
      id: "wrong",
      loadExtensions: [".dat"],
      saveExtensions: [".dat"],
      loadCodec: async () => ({
        async load() {
          throw new DecodeError("The header is wrong.");
        },
        async save() {},
      }),
    });
    const { flows, access, tabs, dialogs, reports } = harness([
      declaredButWrong,
      rawType({ sniff: sniffsRaw }),
    ]);
    access.opened = [{ name: "pic.dat", bytes: async () => rawBytes(2, 2) }];

    await flows.openFiles();

    expect(dialogs.request).toBeUndefined();
    expect(reports).toEqual([]);
    expect(tabs.state.items[0]?.value.file?.typeId).toBe("raw");
  });

  it("reports the declared type's error when no other type decodes the file", async () => {
    const declaredButWrong = rawType({
      id: "wrong",
      loadExtensions: [".dat"],
      loadCodec: async () => ({
        async load() {
          throw new DecodeError("The header is wrong.");
        },
        async save() {},
      }),
    });
    const { flows, access, tabs, dialogs } = harness([
      declaredButWrong,
      rawType({ sniff: sniffsRaw }),
    ]);
    access.opened = [{ name: "pic.dat", bytes: async () => new Uint8Array([2, 2, 1]) }];

    const done = flows.openFiles();
    const failed = await dialogOf(dialogs, "transferError");
    expect(failed.message).toContain("There was an error opening the file.");
    failed.answer("skip");
    await done;

    expect(tabs.count).toBe(0);
  });

  it("still says the type is not recognized when neither the name nor the content match", async () => {
    const { flows, access, tabs, dialogs } = harness([rawType({ sniff: sniffsRaw })]);
    access.opened = [{ name: "notes.xyz", bytes: async () => new Uint8Array([9, 9, 9]) }];

    const done = flows.openFiles();
    const failed = await dialogOf(dialogs, "transferError");
    expect(failed.message).toBe(
      "There was an error transferring the image:\n\nThe image type is not recognized, and cannot be opened.",
    );
    failed.answer("skip");
    await done;

    expect(tabs.count).toBe(0);
  });
});

describe("Open Recent (FMT-OPEN-06)", () => {
  it("reopens an entry through its stored handle", async () => {
    const { flows, access, tabs, recent } = harness();
    const entry = recent.add({ name: "stored.raw", handle: handle("stored.raw") });

    await flows.openRecent(entry.id);

    expect(tabs.state.items.map((item) => item.value.name)).toEqual(["stored.raw"]);
    expect(access.written).toEqual([]);
  });

  it("removes an entry whose file is gone, and says so", async () => {
    const { flows, access, recent, notes } = harness();
    const entry = recent.add({ name: "gone.raw", handle: handle("gone.raw") });
    access.openError = new DOMException("gone", "NotFoundError");

    await flows.openRecent(entry.id);

    expect(recent.get(entry.id)).toBeUndefined();
    expect(notes).toEqual(["The file could not be found."]);
  });

  it("opens the picker for an entry without a handle", async () => {
    const { flows, access, tabs, recent } = harness();
    const entry = recent.add({ name: "named.raw" });
    access.opened = [{ name: "named.raw", bytes: async () => rawBytes(1, 1) }];

    await flows.openRecent(entry.id);

    expect(access.pickerCalls).toHaveLength(1);
    expect(tabs.count).toBe(1);
  });

  it("clears the list", () => {
    const { flows, recent } = harness();
    recent.add({ name: "a.raw" });
    flows.clearRecent();
    expect(recent.entries).toEqual([]);
  });
});

describe("Save and Save As (FMT-SAVE-01, FMT-SAVE-03)", () => {
  it("prompts Save As with the suggested name, writes the encoded bytes, and renames the tab", async () => {
    const { flows, access, tabs, recent } = harness();
    const doc = dirtyDocument();
    tabs.open({ name: "Untitled", document: doc });
    const target = handle("art.raw");
    access.saveTarget = { name: "art.raw", handle: target };

    const outcome = await flows.save(tabs.state.items[0]?.id ?? "", true);

    expect(outcome).toBe("saved");
    expect(access.suggestions).toEqual(["Untitled.raw"]);
    expect(access.written[0]?.handle).toBe(target);
    expect([...(access.written[0]?.bytes ?? [])].slice(0, 2)).toEqual([2, 2]);
    expect(access.written[0]?.bytes.length).toBe(2 + 2 * 2 * 4);
    expect(tabs.state.items[0]?.value.name).toBe("art.raw");
    expect(tabs.state.items[0]?.value.file?.typeId).toBe("raw");
    expect(doc.dirty).toBe(false);
    expect(recent.entries[0]?.name).toBe("art.raw");
  });

  it("leaves the image unsaved and the file untouched when the picker is canceled", async () => {
    const { flows, access, tabs } = harness();
    const doc = dirtyDocument();
    tabs.open({ name: "Untitled", document: doc });

    const outcome = await flows.save(tabs.state.items[0]?.id ?? "", true);

    expect(outcome).toBe("canceled");
    expect(access.written).toEqual([]);
    expect(doc.dirty).toBe(true);
  });

  it("writes straight to the handle on Save without asking for a name", async () => {
    const { flows, access, tabs } = harness();
    const target = handle("old.raw");
    tabs.open({
      name: "old.raw",
      document: dirtyDocument(),
      file: { typeId: "raw", handle: target },
    });

    const outcome = await flows.save(tabs.state.items[0]?.id ?? "", false);

    expect(outcome).toBe("saved");
    expect(access.suggestions).toEqual([]);
    expect(access.written[0]?.handle).toBe(target);
  });

  it("leaves the file alone and reports a refused write, keeping the image unsaved", async () => {
    const { flows, access, tabs, notes } = harness();
    const doc = dirtyDocument();
    tabs.open({
      name: "old.raw",
      document: doc,
      file: { typeId: "raw", handle: handle("old.raw") },
    });
    access.writeError = new DOMException("denied", "NotAllowedError");

    const outcome = await flows.save(tabs.state.items[0]?.id ?? "", false);

    expect(outcome).toBe("failed");
    expect(notes).toEqual([
      "Access is denied. Use File > Save As... to save under a different location or name.",
    ]);
    expect(doc.dirty).toBe(true);
    expect(tabs.state.items[0]?.value.name).toBe("old.raw");
  });

  it("reports an I/O error for a write that fails for any other reason", async () => {
    const { flows, access, tabs, notes } = harness();
    tabs.open({
      name: "old.raw",
      document: dirtyDocument(),
      file: { typeId: "raw", handle: handle("old.raw") },
    });
    access.writeError = new DOMException("disk", "UnknownError");

    await flows.save(tabs.state.items[0]?.id ?? "", false);

    expect(notes).toEqual(["An I/O error occurred when writing to the file."]);
  });

  it("reports an encoder failure as a generic save error and writes nothing", async () => {
    const faulty = rawType({
      id: "faulty",
      saveExtensions: [".faulty"],
      loadExtensions: [".faulty"],
      loadCodec: async () => ({
        ...rawCodec,
        save: async () => {
          throw new Error("encoder broke");
        },
      }),
    });
    const { flows, access, tabs, notes } = harness([faulty]);
    access.saveTarget = { name: "x.faulty", handle: handle("x.faulty") };
    tabs.open({ name: "Untitled", document: dirtyDocument() });

    const outcome = await flows.save(tabs.state.items[0]?.id ?? "", true);

    expect(outcome).toBe("failed");
    expect(access.written).toEqual([]);
    expect(notes).toEqual(["There was an error while saving the file."]);
  });

  it("asks name and type in the download dialog when the browser cannot pick a file", async () => {
    const { flows, access, tabs, dialogs, recent } = harness();
    access.canPickSaveTarget = false;
    const doc = dirtyDocument();
    tabs.open({ name: "Untitled", document: doc });

    const done = flows.save(tabs.state.items[0]?.id ?? "", true);
    const prompt = await dialogOf(dialogs, "saveName");
    expect(prompt.name).toBe("Untitled.raw");
    expect(prompt.types).toEqual([{ id: "raw", label: "PNG" }]);
    prompt.answer({ name: "sketch", typeId: "raw" });

    expect(await done).toBe("saved");
    expect(access.downloads[0]?.name).toBe("sketch.raw");
    expect(access.downloads[0]?.bytes.length).toBe(2 + 2 * 2 * 4);
    expect(tabs.state.items[0]?.value.name).toBe("sketch.raw");
    expect(tabs.state.items[0]?.value.file?.handle).toBeUndefined();
    expect(recent.entries[0]?.handle).toBeUndefined();
    expect(doc.dirty).toBe(false);
  });

  it("makes Save behave as Save As after a download", async () => {
    const { flows, access, tabs, dialogs } = harness();
    access.canPickSaveTarget = false;
    tabs.open({ name: "Untitled", document: dirtyDocument() });
    const first = flows.save(tabs.state.items[0]?.id ?? "", true);
    (await dialogOf(dialogs, "saveName")).answer({ name: "one", typeId: "raw" });
    await first;

    const second = flows.save(tabs.state.items[0]?.id ?? "", false);
    expect((await dialogOf(dialogs, "saveName")).name).toBe("one.raw");
    (await dialogOf(dialogs, "saveName")).answer(undefined);
    expect(await second).toBe("canceled");
  });

  it("asks to flatten a multi-layer image before saving a flat format, and saves after Flatten", async () => {
    const { flows, access, tabs, dialogs } = harness();
    const doc = dirtyDocument();
    doc.addLayer();
    tabs.open({ name: "Untitled", document: doc });
    access.saveTarget = { name: "flat.raw", handle: handle("flat.raw") };

    const done = flows.save(tabs.state.items[0]?.id ?? "", true);
    (await dialogOf(dialogs, "flatten")).answer(true);

    expect(await done).toBe("saved");
    expect(doc.layerCount).toBe(1);
    expect(access.written).toHaveLength(1);
  });

  it("writes nothing when the flatten prompt is canceled", async () => {
    const { flows, access, tabs, dialogs } = harness();
    const doc = dirtyDocument();
    doc.addLayer();
    tabs.open({ name: "Untitled", document: doc });
    access.saveTarget = { name: "flat.raw", handle: handle("flat.raw") };

    const done = flows.save(tabs.state.items[0]?.id ?? "", true);
    (await dialogOf(dialogs, "flatten")).answer(false);

    expect(await done).toBe("canceled");
    expect(doc.layerCount).toBe(2);
    expect(access.written).toEqual([]);
  });
});

describe("Save All (FMT-SAVE-01)", () => {
  it("saves only the images with unsaved changes, prompting for the untitled ones", async () => {
    const { flows, access, tabs } = harness();
    const clean = Document.createBlank({ width: 2, height: 2 });
    tabs.open({
      name: "Clean",
      document: clean,
      file: { typeId: "raw", handle: handle("clean.raw") },
    });
    tabs.open({
      name: "Changed",
      document: dirtyDocument(),
      file: { typeId: "raw", handle: handle("changed.raw") },
    });
    tabs.open({ name: "Untitled", document: dirtyDocument() });
    access.saveTarget = { name: "new.raw", handle: handle("new.raw") };

    await flows.saveAll();

    expect(access.written.map((write) => write.handle.name)).toEqual(["changed.raw", "new.raw"]);
    expect(access.suggestions).toEqual(["Untitled.raw"]);
  });

  it("stops at the first prompt that is canceled", async () => {
    const { flows, access, tabs } = harness();
    tabs.open({ name: "First", document: dirtyDocument() });
    tabs.open({ name: "Second", document: dirtyDocument() });

    const saved = await flows.saveImages(tabs.state.items.map((item) => item.id));

    expect(saved).toBe(false);
    expect(access.written).toEqual([]);
    expect(access.suggestions).toEqual(["First.raw"]);
  });

  it("reports whether every listed image was saved", async () => {
    const { flows, access, tabs } = harness();
    access.saveTarget = { name: "a.raw", handle: handle("a.raw") };
    tabs.open({ name: "A", document: dirtyDocument() });

    expect(await flows.saveImages(tabs.state.items.map((item) => item.id))).toBe(true);
  });

  it("does nothing for an image that was closed while waiting", async () => {
    const { flows, access, tabs } = harness();
    expect(await flows.saveImages(["gone"])).toBe(true);
    expect(access.written).toEqual([]);
    expect(tabs.count).toBe(0);
  });
});

describe("Save Configuration (FMT-UI-01..03)", () => {
  it("shows the options after the picker, writes the chosen values, and remembers them", async () => {
    const { flows, access, tabs, dialogs, savedConfig } = harness([optionType()]);
    tabs.open({ name: "Untitled", document: dirtyDocument() });
    access.saveTarget = { name: "pic.cfg", handle: handle("pic.cfg") };

    const done = flows.save(tabs.state.items[0]?.id ?? "", true);
    const configure = await dialogOf(dialogs, "saveConfig");
    expect(configure.values).toEqual({ removeMetadata: false });
    configure.answer({ values: { removeMetadata: true }, encoded: undefined });

    expect(await done).toBe("saved");
    expect(access.written[0]?.bytes[0]).toBe(1);
    expect(savedConfig.get("cfg")).toEqual({ removeMetadata: true });
  });

  it("writes the bytes of the final preview when the values are unchanged", async () => {
    const { flows, access, tabs, dialogs } = harness([optionType()]);
    tabs.open({ name: "Untitled", document: dirtyDocument() });
    access.saveTarget = { name: "pic.cfg", handle: handle("pic.cfg") };

    const done = flows.save(tabs.state.items[0]?.id ?? "", true);
    (await dialogOf(dialogs, "saveConfig")).answer({
      values: { removeMetadata: false },
      encoded: Uint8Array.of(42, 43),
    });

    expect(await done).toBe("saved");
    expect([...(access.written[0]?.bytes ?? [])]).toEqual([42, 43]);
  });

  it("writes nothing and keeps the old options when the dialog is canceled", async () => {
    const { flows, access, tabs, dialogs, savedConfig } = harness([optionType()]);
    const doc = dirtyDocument();
    tabs.open({ name: "Untitled", document: doc });
    access.saveTarget = { name: "pic.cfg", handle: handle("pic.cfg") };

    const done = flows.save(tabs.state.items[0]?.id ?? "", true);
    (await dialogOf(dialogs, "saveConfig")).answer(undefined);

    expect(await done).toBe("canceled");
    expect(access.written).toEqual([]);
    expect(doc.dirty).toBe(true);
    expect(savedConfig.has("cfg")).toBe(false);
  });

  it("skips the dialog on plain Save and reuses the remembered options", async () => {
    const { flows, access, tabs, dialogs, savedConfig } = harness([optionType()]);
    savedConfig.set("cfg", { removeMetadata: true });
    tabs.open({
      name: "old.cfg",
      document: dirtyDocument(),
      file: { typeId: "cfg", handle: handle("old.cfg") },
    });

    expect(await flows.save(tabs.state.items[0]?.id ?? "", false)).toBe("saved");
    expect(dialogs.request).toBeUndefined();
    expect(access.written[0]?.bytes[0]).toBe(1);
  });

  it("asks to flatten after the options, and writes nothing when Flatten is canceled", async () => {
    const { flows, access, tabs, dialogs } = harness([optionType()]);
    const doc = dirtyDocument();
    doc.addLayer();
    tabs.open({ name: "Untitled", document: doc });
    access.saveTarget = { name: "flat.cfg", handle: handle("flat.cfg") };

    const done = flows.save(tabs.state.items[0]?.id ?? "", true);
    (await dialogOf(dialogs, "saveConfig")).answer({
      values: { removeMetadata: false },
      encoded: undefined,
    });
    (await dialogOf(dialogs, "flatten")).answer(false);

    expect(await done).toBe("canceled");
    expect(doc.layerCount).toBe(2);
    expect(access.written).toEqual([]);
  });

  it("does not show the dialog for a type without save options", async () => {
    const { flows, access, tabs, dialogs } = harness();
    access.saveTarget = { name: "plain.raw", handle: handle("plain.raw") };
    tabs.open({ name: "Untitled", document: dirtyDocument() });

    const done = flows.save(tabs.state.items[0]?.id ?? "", true);

    expect(await done).toBe("saved");
    expect(dialogs.request).toBeUndefined();
  });
});

/** A format whose one file holds two layers, so an import composites them. */
function twoLayerType(): FileTypeDescriptor {
  const layer = (name: string, value: number, isBackground: boolean) => ({
    name,
    visible: true,
    opacity: 255,
    blendMode: 0,
    surface: new Surface(2, 2, new Uint8ClampedArray(16).fill(value)),
    isBackground,
  });
  return rawType({
    id: "two",
    loadExtensions: [".two"],
    saveExtensions: [".two"],
    mimeTypes: ["application/x-two"],
    loadCodec: async () => ({
      async load(source) {
        await source.readAll();
        return {
          width: 2,
          height: 2,
          resolution: DEFAULT_RESOLUTION,
          colorProfile: "srgb",
          metadata: { xmp: [], user: {} },
          layers: [layer("Back", 1, true), layer("Top", 2, false)],
        };
      },
      async save() {},
    }),
  });
}

function blankImage(width: number, height: number, name = "Untitled"): OpenImage {
  return { name, document: Document.createBlank({ width, height }) };
}

describe("Print (FMT-PRN-01)", () => {
  it("prints the flattened image fit to the page", async () => {
    const { flows, tabs, dialogs, printer } = harness();
    tabs.open({ name: "sketch.raw", document: dirtyDocument(3, 2) });

    const done = flows.printActive();
    (await dialogOf(dialogs, "print")).answer("fit");
    await done;

    expect(printer.jobs).toEqual([
      {
        src: "data:image/png;base64,PRINT",
        alt: "sketch.raw",
        layout: { mode: "fit", width: "100%", height: "100%" },
      },
    ]);
    expect(dialogs.request).toBeUndefined();
  });

  it("prints at the document's real size when Actual size is chosen", async () => {
    const { flows, tabs, dialogs, printer } = harness();
    const doc = dirtyDocument(3, 2);
    doc.setResolution({ unit: "inch", x: 300, y: 150 });
    tabs.open({ name: "sketch.raw", document: doc });

    const done = flows.printActive();
    (await dialogOf(dialogs, "print")).answer("actual");
    await done;

    expect(printer.jobs[0]?.layout).toEqual({
      mode: "actual",
      width: `${3 / 300}in`,
      height: `${2 / 150}in`,
    });
  });

  it("leaves the document as it was", async () => {
    const { flows, tabs, dialogs } = harness();
    const doc = dirtyDocument();
    const undoable = doc.history.canUndo;
    tabs.open({ name: "sketch.raw", document: doc });

    const done = flows.printActive();
    (await dialogOf(dialogs, "print")).answer("fit");
    await done;

    expect(doc.dirty).toBe(true);
    expect(doc.history.canUndo).toBe(undoable);
    expect(doc.layerCount).toBe(1);
  });

  it("prints nothing with no image open", async () => {
    const { flows, dialogs, printer } = harness();

    await flows.printActive();

    expect(dialogs.request).toBeUndefined();
    expect(printer.jobs).toEqual([]);
  });

  it("says printing is not available, and prints nothing, when the browser cannot print", async () => {
    const { flows, tabs, dialogs, printer, notes } = harness();
    printer.supported = false;
    tabs.open({ name: "sketch.raw", document: dirtyDocument() });

    await flows.printActive();

    expect(notes).toEqual([t("print.unavailable")]);
    expect(dialogs.request).toBeUndefined();
    expect(printer.jobs).toEqual([]);
  });

  it("prints nothing when the print dialog is canceled", async () => {
    const { flows, tabs, dialogs, printer } = harness();
    tabs.open({ name: "sketch.raw", document: dirtyDocument() });

    const done = flows.printActive();
    (await dialogOf(dialogs, "print")).answer(undefined);
    await done;

    expect(dialogs.request).toBeUndefined();
    expect(printer.jobs).toEqual([]);
  });

  it("says there is not enough memory when the flattened image cannot be allocated", async () => {
    const { flows, tabs, dialogs, printer, notes } = harness();
    printer.encodeError = new OutOfMemoryError(100, 0);
    tabs.open({ name: "sketch.raw", document: dirtyDocument() });

    const done = flows.printActive();
    (await dialogOf(dialogs, "print")).answer("fit");
    await done;

    expect(notes).toEqual([t("print.outOfMemory")]);
    expect(printer.jobs).toEqual([]);
  });

  it("says there is not enough memory when the browser cannot encode the image", async () => {
    const { flows, tabs, dialogs, printer, notes } = harness();
    printer.encoded = undefined;
    tabs.open({ name: "sketch.raw", document: dirtyDocument() });

    const done = flows.printActive();
    (await dialogOf(dialogs, "print")).answer("fit");
    await done;

    expect(notes).toEqual([t("print.outOfMemory")]);
    expect(printer.jobs).toEqual([]);
  });
});

describe("Import From File (DOC-LYR-05e)", () => {
  it("adds each picked file as a new layer named after the file and its layer", async () => {
    const { flows, access, tabs, dialogs } = harness();
    tabs.open(blankImage(4, 4));
    access.opened = [{ name: "pic.raw", bytes: async () => rawBytes(2, 2, 9) }];

    await flows.importFromFile();

    const doc = tabs.state.items[0]?.value.document;
    expect(tabs.state.items).toHaveLength(1);
    expect(doc?.layerCount).toBe(2);
    expect(doc?.layers[1]?.name).toBe("pic.raw: Background");
    const pixels = doc?.layers[1]?.pixels;
    expect(pixels?.readRegion(pixels.bounds).data[0]).toBe(9);
    expect(dialogs.request).toBeUndefined();
  });

  it("composites a layered file into one layer", async () => {
    const { flows, access, tabs } = harness([twoLayerType()]);
    tabs.open(blankImage(4, 4));
    access.opened = [{ name: "x.two", bytes: async () => new Uint8Array(new ArrayBuffer(1)) }];

    await flows.importFromFile();

    const doc = tabs.state.items[0]?.value.document;
    expect(doc?.layerCount).toBe(2);
    expect(doc?.layers[1]?.name).toBe("x.two: Composite");
  });

  it("asks about an image larger than the canvas, and expands the canvas when asked", async () => {
    const { flows, access, tabs, dialogs } = harness();
    tabs.open(blankImage(2, 2));
    access.opened = [{ name: "big.raw", bytes: async () => rawBytes(4, 3, 9) }];

    const done = flows.importFromFile();
    (await dialogOf(dialogs, "importSize")).answer("expand");
    await done;

    const doc = tabs.state.items[0]?.value.document;
    expect(doc?.width).toBe(4);
    expect(doc?.height).toBe(3);
    expect(doc?.layerCount).toBe(2);
    expect(dialogs.request).toBeUndefined();
  });

  it("keeps the canvas size when Keep is chosen", async () => {
    const { flows, access, tabs, dialogs } = harness();
    tabs.open(blankImage(2, 2));
    access.opened = [{ name: "big.raw", bytes: async () => rawBytes(4, 3, 9) }];

    const done = flows.importFromFile();
    (await dialogOf(dialogs, "importSize")).answer("keep");
    await done;

    const doc = tabs.state.items[0]?.value.document;
    expect(doc?.width).toBe(2);
    expect(doc?.height).toBe(2);
    expect(doc?.layerCount).toBe(2);
  });

  it("adds nothing when the size prompt is canceled", async () => {
    const { flows, access, tabs, dialogs } = harness();
    tabs.open(blankImage(2, 2));
    access.opened = [{ name: "big.raw", bytes: async () => rawBytes(4, 3, 9) }];

    const done = flows.importFromFile();
    (await dialogOf(dialogs, "importSize")).answer("cancel");
    await done;

    expect(tabs.state.items[0]?.value.document.layerCount).toBe(1);
  });

  it("does nothing with no image open", async () => {
    const { flows, access, tabs } = harness();
    access.opened = [{ name: "pic.raw", bytes: async () => rawBytes(2, 2) }];

    await flows.importFromFile();

    expect(tabs.state.items).toHaveLength(0);
    expect(access.pickerCalls).toHaveLength(0);
  });
});

describe("Dropped files (UI-DOC-02, WEB-FILE-06)", () => {
  const rawFile = (name: string, width = 2, height = 2) =>
    new File([rawBytes(width, height, 9)], name);

  it("opens one dropped file directly when no image is open", async () => {
    const { flows, tabs, dialogs } = harness();

    await flows.dropped({ files: [rawFile("drop.raw")], urls: [] });

    expect(tabs.state.items.map((item) => item.value.name)).toEqual(["drop.raw"]);
    expect(dialogs.request).toBeUndefined();
  });

  it("does nothing when a drop holds nothing the app opens", async () => {
    const { flows, tabs, dialogs } = harness();

    await flows.dropped({ files: [], urls: [] });

    expect(tabs.state.items).toHaveLength(0);
    expect(dialogs.request).toBeUndefined();
  });

  it("asks Open or Add layers when an image is open, and Open adds a tab for each file", async () => {
    const { flows, tabs, dialogs } = harness();
    tabs.open(blankImage(4, 4));

    const done = flows.dropped({ files: [rawFile("a.raw"), rawFile("b.raw")], urls: [] });
    const request = await dialogOf(dialogs, "dropChoice");
    expect(request.count).toBe(2);
    expect(request.hasImage).toBe(true);
    request.answer("open");
    await done;

    expect(tabs.state.items.map((item) => item.value.name)).toEqual(["Untitled", "a.raw", "b.raw"]);
  });

  it("adds dropped files as layers of the current image", async () => {
    const { flows, tabs, dialogs } = harness();
    tabs.open(blankImage(4, 4));

    const done = flows.dropped({ files: [rawFile("a.raw"), rawFile("b.raw")], urls: [] });
    (await dialogOf(dialogs, "dropChoice")).answer("addLayers");
    await done;

    const doc = tabs.state.items[0]?.value.document;
    expect(tabs.state.items).toHaveLength(1);
    expect(doc?.layers.map((layer) => layer.name)).toEqual([
      "Background",
      "a.raw: Background",
      "b.raw: Background",
    ]);
  });

  it("creates a new blank image at the default size before adding layers when none is open", async () => {
    const { flows, tabs, dialogs } = harness();

    const done = flows.dropped({ files: [rawFile("a.raw"), rawFile("b.raw")], urls: [] });
    const request = await dialogOf(dialogs, "dropChoice");
    expect(request.hasImage).toBe(false);
    request.answer("addLayers");
    await done;

    const doc = tabs.state.items[0]?.value.document;
    expect(tabs.state.items).toHaveLength(1);
    expect(tabs.state.items[0]?.value.name).toBe("Untitled");
    expect(doc?.width).toBe(8);
    expect(doc?.height).toBe(6);
    expect(doc?.layerCount).toBe(3);
  });

  it("adds nothing when the question is canceled", async () => {
    const { flows, tabs, dialogs } = harness();
    tabs.open(blankImage(4, 4));

    const done = flows.dropped({ files: [rawFile("a.raw"), rawFile("b.raw")], urls: [] });
    (await dialogOf(dialogs, "dropChoice")).answer(undefined);
    await done;

    expect(tabs.state.items).toHaveLength(1);
    expect(tabs.state.items[0]?.value.document.layerCount).toBe(1);
  });

  it("fetches an image dragged from another page and opens it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(rawBytes(2, 2), { headers: { "content-type": "application/x-raw" } }),
      ),
    );
    try {
      const { flows, tabs } = harness();

      await flows.dropped({ files: [], urls: ["https://example.com/pics/photo"] });

      expect(tabs.state.items[0]?.value.name).toBe("photo.raw");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports an image address that cannot be read, and opens nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    try {
      const { flows, tabs, notes } = harness();

      await flows.dropped({ files: [], urls: ["https://example.com/private.png"] });

      expect(tabs.state.items).toHaveLength(0);
      expect(notes).toEqual([
        "The image could not be downloaded from its web address. The site may not allow it.",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("OS file handling (WEB-FILE-05)", () => {
  it("opens each file the OS launched as a tab, in order", async () => {
    const { flows, tabs } = harness();

    await flows.openHandles([handle("one.raw"), handle("two.raw")]);

    expect(tabs.state.items.map((item) => item.value.name)).toEqual(["one.raw", "two.raw"]);
    expect(tabs.state.items[1]?.value.file?.handle?.name).toBe("two.raw");
  });

  it("reports a launched file it cannot open and opens the rest", async () => {
    const { flows, access, tabs, notes } = harness();
    access.openError = Object.assign(new Error("gone"), { name: "NotFoundError" });

    await flows.openHandles([handle("gone.raw")]);

    expect(tabs.state.items).toHaveLength(0);
    expect(notes).toEqual(["The file could not be found."]);
  });
});
