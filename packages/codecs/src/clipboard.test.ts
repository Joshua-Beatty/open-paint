import {
  ClipboardError,
  type ClipboardImage,
  OutOfMemoryError,
  rgba8,
  Surface,
} from "@openpaint/document";
import { describe, expect, it } from "vitest";
import {
  type ClipboardCodecs,
  type ClipboardEntry,
  ClipboardService,
  clipboardSelection,
  PNG_TYPE,
  SELECTION_TYPE,
  type SystemClipboard,
} from "./clipboard";
import { decodePng, encodePngAsync } from "./png";
import { deflateZlib, inflateZlib } from "./zlib";

/** A system clipboard that keeps whatever was last written, and can refuse writes. */
class FakeClipboard implements SystemClipboard {
  entries: ClipboardEntry[] = [];
  failWrites = false;

  async write(record: Readonly<Record<string, Blob>>): Promise<void> {
    if (this.failWrites) throw new Error("clipboard is busy");
    this.entries = Object.entries(record).map(([type, blob]) => ({ type, blob }));
  }

  async read(): Promise<readonly ClipboardEntry[]> {
    return this.entries;
  }
}

const codecs: ClipboardCodecs = {
  encodePng: (image) => encodePngAsync(image, deflateZlib),
  async decodeImage(blob) {
    const image = await decodePng(new Uint8Array(await blob.arrayBuffer()), inflateZlib);
    return new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  },
};

function sample(): ClipboardImage {
  const pixels = new Surface(3, 2);
  pixels.setPixel(0, 0, rgba8(255, 0, 0));
  pixels.setPixel(2, 1, rgba8(10, 20, 30, 128));
  return { pixels, origin: { x: 5, y: 7 }, outline: [[0, 0, 3, 0, 3, 2]] };
}

function pngBytesOf(pixels: Surface): Promise<Uint8Array> {
  return encodePngAsync(
    { width: pixels.width, height: pixels.height, data: new Uint8Array(pixels.data) },
    deflateZlib,
  );
}

function base64Of(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function expectClipboardError(promise: Promise<unknown>, messageId: string) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ClipboardError);
  expect((error as ClipboardError).messageId).toBe(messageId);
}

describe("ClipboardService copy", () => {
  it("writes the PNG and the outline in canvas coordinates", async () => {
    const system = new FakeClipboard();
    await new ClipboardService(system, codecs).copyImage(sample());
    const types = system.entries.map((entry) => entry.type).sort();
    expect(types).toEqual([PNG_TYPE, SELECTION_TYPE].sort());
    const outline = system.entries.find((entry) => entry.type === SELECTION_TYPE);
    expect(await outline?.blob.text()).toBe('{"polygonList":["5,7,8,7,8,9"]}');
  });

  it("types every blob as its entry, which Chromium requires of custom types", async () => {
    const system = new FakeClipboard();
    const service = new ClipboardService(system, codecs);
    await service.copyImage(sample());
    expect(system.entries.every((entry) => entry.blob.type === entry.type)).toBe(true);
    await service.copyOutline([[1, 1, 4, 1, 4, 4]]);
    expect(system.entries.every((entry) => entry.blob.type === entry.type)).toBe(true);
  });

  it("tags the PNG as sRGB", async () => {
    const bytes = await pngBytesOf(sample().pixels);
    expect(new TextDecoder("latin1").decode(bytes)).toContain("sRGB");
  });

  it("omits the outline when the copy had no selection", async () => {
    const system = new FakeClipboard();
    await new ClipboardService(system, codecs).copyImage({ pixels: new Surface(2, 2) });
    expect(system.entries.map((entry) => entry.type)).toEqual([PNG_TYPE]);
  });

  it("writes only the outline for Copy Selection, as the custom type and text", async () => {
    const system = new FakeClipboard();
    await new ClipboardService(system, codecs).copyOutline([[1, 1, 4, 1, 4, 4]]);
    expect(system.entries.map((entry) => entry.type).sort()).toEqual(
      [SELECTION_TYPE, "text/plain"].sort(),
    );
    const text = await system.entries[0]?.blob.text();
    expect(text).toBe('{"polygonList":["1,1,4,1,4,4"]}');
  });

  it("maps a memory failure while encoding to the out-of-memory message", async () => {
    const failing: ClipboardCodecs = {
      ...codecs,
      encodePng: async () => {
        throw new OutOfMemoryError(10, 0);
      },
    };
    await expectClipboardError(
      new ClipboardService(new FakeClipboard(), failing).copyImage(sample()),
      "clipboard.outOfMemory",
    );
  });

  it("reports a refused write as a copy error and keeps the previous in-app copy", async () => {
    const system = new FakeClipboard();
    const service = new ClipboardService(system, codecs);
    const first = sample();
    await service.copyImage(first);
    system.failWrites = true;
    await expectClipboardError(
      service.copyImage({ pixels: new Surface(1, 1) }),
      "clipboard.copyError",
    );
    expect((await service.read()).image).toBe(first);
  });
});

describe("ClipboardService read", () => {
  it("returns the exact in-app copy while the system clipboard still holds it", async () => {
    const system = new FakeClipboard();
    const service = new ClipboardService(system, codecs);
    const copied = sample();
    await service.copyImage(copied);
    const contents = await service.read();
    expect(contents.image).toBe(copied);
    expect(contents.outline).toEqual([[5, 7, 8, 7, 8, 9]]);
  });

  it("decodes the PNG once the system clipboard holds something else", async () => {
    const system = new FakeClipboard();
    const service = new ClipboardService(system, codecs);
    await service.copyImage(sample());
    const other = new Surface(2, 1);
    other.setPixel(1, 0, rgba8(0, 255, 0, 64));
    system.entries = [{ type: PNG_TYPE, blob: new Blob([(await pngBytesOf(other)).slice()]) }];
    const contents = await service.read();
    expect(contents.image?.origin).toBeUndefined();
    expect(contents.image?.outline).toBeUndefined();
    expect(contents.image?.pixels.width).toBe(2);
    expect(contents.image?.pixels.getPixel(1, 0)).toEqual(rgba8(0, 255, 0, 64));
  });

  it("forgets the in-app copy once the clipboard is overwritten with an outline", async () => {
    const system = new FakeClipboard();
    const service = new ClipboardService(system, codecs);
    await service.copyImage(sample());
    await service.copyOutline([[0, 0, 2, 0, 0, 2]]);
    const contents = await service.read();
    expect(contents.image).toBeUndefined();
    expect(contents.outline).toEqual([[0, 0, 2, 0, 0, 2]]);
  });

  it("reads an outline from text/plain when the custom type is missing", async () => {
    const system = new FakeClipboard();
    system.entries = [{ type: "text/plain", blob: new Blob(['{"polygonList":["0,0,1,0,1,1"]}']) }];
    const contents = await new ClipboardService(system, codecs).read();
    expect(contents.outline).toEqual([[0, 0, 1, 0, 1, 1]]);
  });

  it("returns text that is not an outline as plain text", async () => {
    const system = new FakeClipboard();
    system.entries = [{ type: "text/plain", blob: new Blob(["hello there"]) }];
    const contents = await new ClipboardService(system, codecs).read();
    expect(contents).toEqual({ image: undefined, outline: undefined, text: "hello there" });
  });

  it("does not report an outline held as text as plain text", async () => {
    const system = new FakeClipboard();
    system.entries = [{ type: "text/plain", blob: new Blob(['{"polygonList":["0,0,1,0,1,1"]}']) }];
    const contents = await new ClipboardService(system, codecs).read();
    expect(contents.text).toBeUndefined();
  });

  it("decodes a base64 PNG data URI in text", async () => {
    const png = await pngBytesOf(sample().pixels);
    const system = new FakeClipboard();
    system.entries = [
      { type: "text/plain", blob: new Blob([`data:image/png;base64,${base64Of(png)}`]) },
    ];
    const contents = await new ClipboardService(system, codecs).read();
    expect(contents.image?.pixels.width).toBe(3);
    expect(contents.image?.pixels.getPixel(2, 1)).toEqual(rgba8(10, 20, 30, 128));
  });

  it("decodes the data URI of an image in HTML", async () => {
    const png = await pngBytesOf(sample().pixels);
    const html = `<meta charset="utf-8"><img alt="" src="data:image/png;base64,${base64Of(png)}">`;
    const system = new FakeClipboard();
    system.entries = [{ type: "text/html", blob: new Blob([html]) }];
    const contents = await new ClipboardService(system, codecs).read();
    expect(contents.image?.pixels.height).toBe(2);
  });

  it("returns no image when nothing on the clipboard decodes", async () => {
    const system = new FakeClipboard();
    system.entries = [
      { type: PNG_TYPE, blob: new Blob([new Uint8Array([1, 2, 3])]) },
      { type: "text/plain", blob: new Blob(["data:image/png;base64,AAAA"]) },
    ];
    const contents = await new ClipboardService(system, codecs).read();
    expect(contents.image).toBeUndefined();
  });

  it("returns an image from readEntries without touching the system clipboard", async () => {
    const png = await pngBytesOf(sample().pixels);
    const contents = await new ClipboardService(new FakeClipboard(), codecs).readEntries([
      { type: PNG_TYPE, blob: new Blob([png.slice()]) },
    ]);
    expect(contents.image?.pixels.width).toBe(3);
  });
});

describe("clipboardSelection", () => {
  it("prefers the outline on the clipboard", () => {
    expect(clipboardSelection({ image: sample(), outline: [[0, 0, 1, 0, 1, 1]] })).toEqual([
      [0, 0, 1, 0, 1, 1],
    ]);
  });

  it("falls back to the image's outline, then its bounds", () => {
    expect(clipboardSelection({ image: sample(), outline: undefined })).toEqual([
      [5, 7, 8, 7, 8, 9],
    ]);
    const bounds = { pixels: new Surface(2, 4), origin: { x: 1, y: 2 } };
    expect(clipboardSelection({ image: bounds, outline: undefined })).toEqual([
      [1, 2, 3, 2, 3, 6, 1, 6],
    ]);
    expect(clipboardSelection({ image: undefined, outline: undefined })).toBeUndefined();
  });
});
