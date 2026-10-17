/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { DEFAULT_RESOLUTION, Document, rect, rgba8, Surface } from "@openpaint/document";
import type { MessageId } from "@openpaint/i18n";
import {
  defaultValues,
  definePropertySchema,
  effectiveControlType,
  layoutOf,
  type PropertySchema,
  type PropertyValues,
} from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  effectMenu,
  findOpenFileType,
  findSaveFileType,
  openAcceptExtensions,
  openFileTypes,
  saveFileTypes,
} from "./discovery";
import type { EffectDescriptor } from "./effects";
import {
  type ByteSink,
  type ByteSource,
  defaultSaveToken,
  type FileCodec,
  type FileTypeDescriptor,
  type FileTypeHost,
} from "./file-types";
import { EffectRegistry, FileTypeRegistry } from "./registry";
import { EXTENSION_API_MAJOR } from "./version";

/** Display names for the two dummy registrations. The catalog ids are reused on purpose. */
const dummyNames: Partial<Record<MessageId, string>> = {
  "effect.gaussianBlur": "Dummy Effect",
  "app.name": "Dummy Format",
};

function resolveLabel(id: MessageId): string {
  return dummyNames[id] ?? id;
}

const dummyEffect: EffectDescriptor = {
  id: "dummy-effect",
  apiVersion: EXTENSION_API_MAJOR,
  label: "effect.gaussianBlur",
  icon: "icon.dummy",
  category: "effect",
  submenu: "Dummy",
  configurable: true,
  kind: "cpuRegion",
  schema: definePropertySchema({
    properties: [
      {
        kind: "int32",
        key: "strength",
        label: "property.quality",
        defaultValue: 3,
        min: 1,
        max: 5,
      },
      { kind: "boolean", key: "invert", label: "property.radius", defaultValue: false },
    ],
  }),
};

const dummyCodec: FileCodec = {
  async load(source: ByteSource) {
    const bytes = await source.readAll();
    const surface = new Surface(1, 1, new Uint8ClampedArray([bytes[0] ?? 0, 0, 0, 255]));
    return {
      width: 1,
      height: 1,
      resolution: DEFAULT_RESOLUTION,
      colorProfile: "srgb",
      metadata: { xmp: [], user: {} },
      layers: [{ name: "Layer 1", visible: true, opacity: 255, blendMode: 0, surface }],
    };
  },
  async save(_document, sink: ByteSink, token: PropertyValues, progress) {
    await sink.write(Uint8Array.of(Number(token.quality)));
    progress(1);
  },
};

const dummyFormat: FileTypeDescriptor = {
  id: "dummy-format",
  apiVersion: EXTENSION_API_MAJOR,
  label: "app.name",
  icon: "icon.dummy",
  loadExtensions: [".dummy"],
  saveExtensions: [".dummy"],
  mimeTypes: ["application/x-openpaint-dummy"],
  capabilities: {
    supportsLayers: false,
    supportsCustomHeaders: false,
    supportsSaving: true,
    supportsLoading: true,
    savesWithProgress: false,
    supportsCancellation: false,
  },
  saveOptions: definePropertySchema({
    properties: [
      {
        kind: "int32",
        key: "quality",
        label: "property.quality",
        defaultValue: 95,
        min: 0,
        max: 100,
      },
    ],
  }),
  loadCodec: async () => dummyCodec,
  isLossless: (token) => token.quality === 100,
};

function byteSource(bytes: Uint8Array): ByteSource {
  return { byteLength: bytes.byteLength, readAll: async () => bytes };
}

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/** A property schema's dialog controls, in layout order. */
function dialogControls(schema: PropertySchema): readonly string[] {
  return layoutOf(schema).flatMap((node) => (node.kind === "control" ? [node.key] : []));
}

describe("EXT-V1-07 registry conformance", () => {
  it("makes a dummy effect and a dummy file type discoverable after they are registered at runtime", async () => {
    const effects = new EffectRegistry();
    const fileTypes = new FileTypeRegistry();
    const host = { services: {} } as FileTypeHost;

    // The app is running with nothing registered yet.
    expect(effectMenu(effects, "effect", resolveLabel)).toEqual({ submenus: [], items: [] });
    expect(openFileTypes(fileTypes)).toEqual([]);

    effects.register(dummyEffect);
    fileTypes.registerFactory(() => [dummyFormat], host);

    // Effects menu: the effect sits under its declared submenu, with an ellipsis because it is
    // configurable.
    expect(effects.get("dummy-effect")).toBe(dummyEffect);
    expect(effectMenu(effects, "effect", resolveLabel)).toEqual({
      submenus: [
        {
          name: "Dummy",
          items: [
            {
              id: "dummy-effect",
              title: "Dummy Effect...",
              icon: "icon.dummy",
              configurable: true,
            },
          ],
        },
      ],
      items: [],
    });

    // Dialog: generated from the property schema, with one control per property and the schema
    // defaults as its starting values.
    expect(dialogControls(dummyEffect.schema)).toEqual(["strength", "invert"]);
    const strength = dummyEffect.schema.properties[0];
    expect(strength && effectiveControlType(strength)).toBe("slider");
    expect(defaultValues(dummyEffect.schema)).toEqual({ strength: 3, invert: false });

    // Open and Save type lists, with the file type's save-options dialog.
    expect(openFileTypes(fileTypes)).toEqual([dummyFormat]);
    expect(saveFileTypes(fileTypes)).toEqual([dummyFormat]);
    expect(openAcceptExtensions(fileTypes)).toEqual([".dummy"]);
    expect(findOpenFileType(fileTypes, ".DUMMY")).toBe(dummyFormat);
    expect(findSaveFileType(fileTypes, ".dummy")).toBe(dummyFormat);
    expect(dialogControls(dummyFormat.saveOptions)).toEqual(["quality"]);
    expect(defaultSaveToken(dummyFormat)).toEqual({ quality: 95 });

    // Decode and encode go through the lazily loaded codec.
    const codec = await dummyFormat.loadCodec();
    const document = await codec.load(byteSource(Uint8Array.of(200)));
    expect(document.layers[0]?.surface.data[0]).toBe(200);
    const written: Uint8Array[] = [];
    await codec.save(
      document,
      { write: async (chunk) => void written.push(chunk) },
      defaultSaveToken(dummyFormat),
      () => {},
    );
    expect(written.map((chunk) => Array.from(chunk))).toEqual([[95]]);
    expect(dummyFormat.isLossless({ quality: 100 })).toBe(true);

    // Applying the effect to a layer creates one history item named after it (EXT-V1-07). The
    // edit below is the dummy's pixel work; the host's apply path is not built yet.
    const doc = Document.createBlank({ width: 2, height: 2 });
    const layer = doc.activeLayer;
    if (!layer) throw new Error("A blank document has an active layer.");
    const historyBefore = doc.history.entries.length;
    const area = rect(0, 0, 2, 2);
    doc.editLayerPixels(resolveLabel(dummyEffect.label), layer, area, (pixels) => {
      const region = pixels.readRegion(area);
      for (let i = 0; i < region.data.length; i += 4) {
        for (let channel = 0; channel < 3; channel++) {
          region.data[i + channel] = 255 - (region.data[i + channel] ?? 0);
        }
      }
      pixels.writeRegion(region, 0, 0);
    });
    expect(doc.history.entries.length).toBe(historyBefore + 1);
    expect(doc.history.undoName).toBe("Dummy Effect");
    expect(layer.pixels.getPixel(0, 0)).toEqual(rgba8(0, 0, 0, 255));
    doc.dispose();
  });
});
