// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isSafeEntryPath, writeZip, ZipArchive, ZipError, type ZipInput } from "./zip";
import { deflateRaw, inflateRaw } from "./zlib";

const TEXT = new TextEncoder();
const MIME = "image/x-openpaint";

function entry(path: string, text: string, deflate = false): ZipInput {
  return { path, data: TEXT.encode(text), deflate };
}

/** Replaces every occurrence of `from` with `to` (same length), in the raw archive bytes. */
function patchName(bytes: Uint8Array, from: string, to: string): Uint8Array {
  const out = bytes.slice();
  const a = TEXT.encode(from);
  const b = TEXT.encode(to);
  expect(a.length).toBe(b.length);
  for (let i = 0; i + a.length <= out.length; i += 1) {
    if (a.every((byte, k) => out[i + k] === byte)) out.set(b, i);
  }
  return out;
}

describe("ZIP writer and reader (FMT-NAT-02)", () => {
  it("round-trips stored and deflated entries in order", async () => {
    const bytes = await writeZip(
      [
        entry("mimetype", MIME),
        entry("document.json", '{"format":"openpaint"}', true),
        entry("layers/0.png", "stored pixels"),
      ],
      { deflate: deflateRaw },
    );
    const archive = ZipArchive.open(bytes);
    expect(archive.entries.map((e) => e.path)).toEqual([
      "mimetype",
      "document.json",
      "layers/0.png",
    ]);
    const json = archive.find("document.json");
    expect(json).toBeDefined();
    if (json === undefined) return;
    expect(json.method).toBe(8);
    expect(new TextDecoder().decode(await archive.read(json, 1024))).toBe('{"format":"openpaint"}');
    const png = archive.find("layers/0.png");
    if (png === undefined) throw new Error("missing entry");
    expect(png.method).toBe(0);
    expect(new TextDecoder().decode(await archive.read(png, 1024))).toBe("stored pixels");
  });

  it("stores the mimetype first, uncompressed, with the MIME string at byte 38", async () => {
    const bytes = await writeZip([entry("mimetype", MIME), entry("document.json", "{}", true)], {
      deflate: deflateRaw,
    });
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(0);
    expect(view.getUint16(26, true)).toBe("mimetype".length);
    expect(view.getUint16(28, true)).toBe(0);
    expect(new TextDecoder().decode(bytes.subarray(38, 38 + MIME.length))).toBe(MIME);
  });

  it("refuses an unsafe path when writing", async () => {
    await expect(writeZip([entry("../escape.png", "x")])).rejects.toBeInstanceOf(ZipError);
  });

  it("refuses an unsafe path in an archive it reads", async () => {
    const bytes = await writeZip([entry("aa/bb", "payload")]);
    expect(() => ZipArchive.open(patchName(bytes, "aa/bb", "../bb"))).toThrow(ZipError);
  });

  it("fails an entry whose CRC-32 does not match", async () => {
    const bytes = await writeZip([entry("data.txt", "abcdef")]);
    const offset = TEXT.encode("data.txt").length + 30;
    const broken = bytes.slice();
    broken[offset] = broken[offset] === 0x61 ? 0x62 : 0x61;
    const archive = ZipArchive.open(broken);
    const found = archive.find("data.txt");
    if (found === undefined) throw new Error("missing entry");
    await expect(archive.read(found, 1024)).rejects.toBeInstanceOf(ZipError);
  });

  it("refuses an entry larger than the limit it is read with", async () => {
    const archive = ZipArchive.open(await writeZip([entry("big.bin", "0123456789")]));
    const found = archive.find("big.bin");
    if (found === undefined) throw new Error("missing entry");
    await expect(archive.read(found, 4)).rejects.toBeInstanceOf(ZipError);
  });

  it("refuses duplicate entry names", async () => {
    const bytes = await writeZip([entry("a.txt", "1"), entry("b.txt", "2")]);
    expect(() => ZipArchive.open(patchName(bytes, "b.txt", "a.txt"))).toThrow(ZipError);
  });

  it("refuses bytes that are not an archive", () => {
    expect(() => ZipArchive.open(TEXT.encode("not a zip file at all"))).toThrow(ZipError);
  });

  it("writes and reads ZIP64 records when they are forced", async () => {
    const bytes = await writeZip([entry("mimetype", MIME), entry("document.json", "{}", true)], {
      deflate: deflateRaw,
      forceZip64: true,
    });
    const archive = ZipArchive.open(bytes);
    expect(archive.entries.map((e) => [e.path, e.size])).toEqual([
      ["mimetype", MIME.length],
      ["document.json", 2],
    ]);
    const json = archive.find("document.json");
    if (json === undefined) throw new Error("missing entry");
    expect(new TextDecoder().decode(await archive.read(json, 16))).toBe("{}");
  });

  it("accepts an archive whose entries are not in offset order in the directory", async () => {
    const archive = ZipArchive.open(await writeZip([entry("z.txt", "z"), entry("a.txt", "a")]));
    expect(archive.entries.map((e) => e.path)).toEqual(["z.txt", "a.txt"]);
  });
});

describe("entry paths (FMT-NAT-02)", () => {
  it("accepts relative slash paths and refuses escapes", () => {
    expect(isSafeEntryPath("layers/0.png")).toBe(true);
    expect(isSafeEntryPath("metadata/xmp-1.xml")).toBe(true);
    for (const bad of [
      "",
      "/abs.png",
      "../x",
      "a/../b",
      "a\\b",
      "C:/x",
      "a//b",
      "a/./b",
      "a/",
      "x\0y",
    ]) {
      expect(isSafeEntryPath(bad)).toBe(false);
    }
  });
});

describe("raw DEFLATE helpers", () => {
  it("round-trips data and refuses output over the limit", async () => {
    const data = TEXT.encode("repeat ".repeat(200));
    const packed = await deflateRaw(data);
    expect(await inflateRaw(packed, data.length)).toEqual(data);
    await expect(inflateRaw(packed, data.length - 1)).rejects.toBeInstanceOf(RangeError);
  });
});
