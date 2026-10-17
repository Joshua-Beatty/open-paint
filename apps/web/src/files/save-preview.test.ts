// @vitest-environment node
import { DEFAULT_RESOLUTION, Surface } from "@openpaint/document";
import {
  EXTENSION_API_MAJOR,
  type FileCodec,
  type FileDocument,
  type FileTypeDescriptor,
} from "@openpaint/extension-api";
import { createTranslator, enUS } from "@openpaint/i18n";
import { describe, expect, it } from "vitest";
import { fileSizeText, type PreviewState, previewSizeText, SavePreview } from "./save-preview";

const t = createTranslator("en-US", enUS);

function flat(surface: Surface): FileDocument {
  return {
    width: surface.width,
    height: surface.height,
    resolution: DEFAULT_RESOLUTION,
    colorProfile: "srgb",
    metadata: { xmp: [], user: {} },
    layers: [{ name: "Background", visible: true, opacity: 255, blendMode: 0, surface }],
  };
}

/** Writes one flag byte (from the option) and the pixels, reporting progress first. */
function optionCodec(options: { readonly fail?: boolean; readonly decoded?: Surface } = {}) {
  const codec: FileCodec = {
    async load() {
      if (options.decoded === undefined) throw new Error("not decodable");
      return flat(options.decoded);
    },
    async save(file, sink, values, progress) {
      await Promise.resolve();
      if (options.fail === true) throw new Error("encoder broke");
      progress(0.5);
      await sink.write(Uint8Array.of(values.removeMetadata === true ? 1 : 0));
      await sink.write(new Uint8Array(file.layers[0]?.surface.data ?? []));
    },
  };
  return codec;
}

function typeOf(lossless: boolean): FileTypeDescriptor {
  return {
    id: "preview",
    apiVersion: EXTENSION_API_MAJOR,
    label: "fileType.png",
    icon: "file-raw",
    loadExtensions: [".preview"],
    saveExtensions: [".preview"],
    mimeTypes: ["application/x-preview"],
    capabilities: {
      supportsLayers: false,
      supportsCustomHeaders: false,
      supportsSaving: true,
      supportsLoading: true,
      savesWithProgress: true,
      supportsCancellation: true,
    },
    saveOptions: { properties: [] },
    loadCodec: async () => optionCodec(),
    isLossless: () => lossless,
  };
}

function pixels(width: number, height: number, value: number): Surface {
  return new Surface(width, height, new Uint8ClampedArray(width * height * 4).fill(value));
}

describe("SavePreview (FMT-UI-03)", () => {
  it("encodes the flattened image with the values and shows the original when lossless", async () => {
    const original = pixels(2, 1, 9);
    const preview = new SavePreview(optionCodec(), typeOf(true), flat(original));

    preview.update({ removeMetadata: true });
    const state = await preview.settled();

    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.bytes[0]).toBe(1);
    expect(state.bytes.byteLength).toBe(1 + 2 * 1 * 4);
    expect(state.image).toBe(original);
  });

  it("decodes a lossy result, so the preview shows what the encoder kept", async () => {
    const decoded = pixels(2, 1, 200);
    const codec = optionCodec({ decoded });
    const preview = new SavePreview(codec, typeOf(false), flat(pixels(2, 1, 9)));

    preview.update({});
    const state = await preview.settled();

    expect(state.kind === "ready" && state.image === decoded).toBe(true);
  });

  it("shows the original when a lossy result cannot be decoded", async () => {
    const original = pixels(1, 1, 5);
    const preview = new SavePreview(optionCodec(), typeOf(false), flat(original));

    preview.update({});
    const state = await preview.settled();

    expect(state.kind === "ready" && state.image === original).toBe(true);
  });

  it("drops a computation that a newer change has superseded", async () => {
    const preview = new SavePreview(optionCodec(), typeOf(true), flat(pixels(1, 1, 1)));

    preview.update({ removeMetadata: false });
    preview.update({ removeMetadata: true });
    const state = await preview.settled();

    expect(state.kind === "ready" && state.bytes[0] === 1).toBe(true);
  });

  it("reports an error when the encoder fails", async () => {
    const preview = new SavePreview(
      optionCodec({ fail: true }),
      typeOf(true),
      flat(pixels(1, 1, 1)),
    );

    preview.update({});

    expect((await preview.settled()).kind).toBe("error");
  });

  it("notifies its listeners as the state changes", async () => {
    const preview = new SavePreview(optionCodec(), typeOf(true), flat(pixels(1, 1, 1)));
    const seen: PreviewState["kind"][] = [];
    const stop = preview.subscribe(() => seen.push(preview.state.kind));

    preview.update({});
    await preview.settled();
    stop();

    expect(seen).toContain("computing");
    expect(seen.at(-1)).toBe("ready");
  });

  it("stops reporting after cancel", async () => {
    const preview = new SavePreview(optionCodec(), typeOf(true), flat(pixels(1, 1, 1)));

    preview.update({});
    preview.cancel();
    const state = await preview.settled();

    expect(state.kind).toBe("computing");
  });

  it("needs an image to preview", () => {
    expect(
      () => new SavePreview(optionCodec(), typeOf(true), { ...flat(pixels(1, 1, 1)), layers: [] }),
    ).toThrow("A preview needs an image.");
  });
});

const computing: PreviewState = { kind: "computing", percent: 0 };

describe("file size text (FMT-UI-02)", () => {
  it("shows bytes, then KB, MB and GB with one decimal at most", () => {
    expect(fileSizeText(5, t)).toBe("5 bytes");
    expect(fileSizeText(1536, t)).toBe("1.5 KB");
    expect(fileSizeText(2048, t)).toBe("2 KB");
    expect(fileSizeText(3 * 1024 ** 2, t)).toBe("3 MB");
    expect(fileSizeText(2 * 1024 ** 3, t)).toBe("2 GB");
  });

  it("describes each preview state", () => {
    expect(previewSizeText(computing, t)).toBe("(computing)");
    expect(previewSizeText({ kind: "computing", percent: 40 }, t)).toBe("(computing: 40%)");
    expect(previewSizeText({ kind: "error" }, t)).toBe("(error)");
    expect(
      previewSizeText(
        { kind: "ready", bytes: new Uint8Array(new ArrayBuffer(2048)), image: pixels(1, 1, 0) },
        t,
      ),
    ).toBe("2 KB");
  });
});
