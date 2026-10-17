import { formatSelectionOutline, rectPolygon } from "@openpaint/document";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pngSize, readClipboardNewSize } from "./clipboard-size";

function pngHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(33));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

interface FakeItem {
  readonly types: string[];
  getType(type: string): Promise<Blob>;
}

function item(type: string, body: BlobPart): FakeItem {
  return { types: [type], getType: async () => new Blob([body], { type }) };
}

function stubClipboard(options: {
  state?: PermissionState | "throws";
  items?: FakeItem[];
  read?: () => Promise<FakeItem[]>;
}) {
  const query =
    options.state === "throws"
      ? vi.fn(() => Promise.reject(new TypeError("unsupported")))
      : vi.fn(() => Promise.resolve({ state: options.state ?? "granted" }));
  const read = vi.fn(options.read ?? (() => Promise.resolve(options.items ?? [])));
  vi.stubGlobal("navigator", {
    permissions: { query },
    clipboard: { read },
  });
  return { query, read };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pngSize (DOC-NEW-01 step 1)", () => {
  it("reads the width and height from the IHDR chunk", () => {
    expect(pngSize(pngHeader(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it("rejects bytes that are not a PNG or have a zero size", () => {
    const notPng = pngHeader(4, 4);
    notPng[1] = 0;
    expect(pngSize(notPng)).toBeUndefined();
    expect(pngSize(pngHeader(0, 4))).toBeUndefined();
    expect(pngSize(new Uint8Array(8))).toBeUndefined();
  });
});

describe("readClipboardNewSize", () => {
  it("never reads the clipboard without a granted read permission", async () => {
    const { read } = stubClipboard({
      state: "prompt",
      items: [item("image/png", pngHeader(9, 9))],
    });
    await expect(readClipboardNewSize()).resolves.toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("gives undefined when the permission query is not supported", async () => {
    const { read } = stubClipboard({ state: "throws" });
    await expect(readClipboardNewSize()).resolves.toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("uses the PNG size of an image on the clipboard", async () => {
    stubClipboard({ items: [item("image/png", pngHeader(120, 80))] });
    await expect(readClipboardNewSize()).resolves.toEqual({ width: 120, height: 80 });
  });

  it("uses the integer bounds of a selection outline when there is no image", async () => {
    const outline = formatSelectionOutline([rectPolygon({ x: 2, y: 3, width: 30, height: 12 })]);
    stubClipboard({ items: [item("text/plain", outline)] });
    await expect(readClipboardNewSize()).resolves.toEqual({ width: 30, height: 12 });
  });

  it("ignores an outline with no area and text that is not an outline", async () => {
    const flat = formatSelectionOutline([rectPolygon({ x: 2, y: 3, width: 30, height: 0 })]);
    stubClipboard({ items: [item("text/plain", flat), item("text/plain", "hello")] });
    await expect(readClipboardNewSize()).resolves.toBeUndefined();
  });

  it("gives undefined when the read fails", async () => {
    stubClipboard({ read: () => Promise.reject(new Error("denied")) });
    await expect(readClipboardNewSize()).resolves.toBeUndefined();
  });
});
