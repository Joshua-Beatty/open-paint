/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeSpill, encodeSpill, SPILL_CHUNK_BYTES } from "./chunks";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

function noise(length: number, seed = 0x2545f491): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = state & 0xff;
  }
  return out;
}

function repeating(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => i % 251);
}

describe("spill chunk codec (ARC-05-01, DOC-HIS-02)", () => {
  it("uses 64 KiB chunks", () => {
    expect(SPILL_CHUNK_BYTES).toBe(64 * 1024);
  });

  it.each([
    ["empty", 0],
    ["one byte", 1],
    ["one chunk exactly", SPILL_CHUNK_BYTES],
    ["one byte past a chunk", SPILL_CHUNK_BYTES + 1],
    ["several chunks", SPILL_CHUNK_BYTES * 3 + 777],
  ])("round-trips %s with LZ4", (_, length) => {
    const raw = repeating(length);
    expect(decodeSpill(encodeSpill(raw, "lz4"))).toEqual(raw);
  });

  it("round-trips with no compression", () => {
    const raw = repeating(SPILL_CHUNK_BYTES + 5);
    const encoded = encodeSpill(raw, "none");
    expect(encoded.length).toBeGreaterThan(raw.length);
    expect(decodeSpill(encoded)).toEqual(raw);
  });

  it("shrinks repetitive data", () => {
    const raw = new Uint8Array(SPILL_CHUNK_BYTES * 2);
    raw.fill(0x7f);
    const encoded = encodeSpill(raw, "lz4");
    expect(encoded.length).toBeLessThan(raw.length / 50);
    expect(decodeSpill(encoded)).toEqual(raw);
  });

  it("stores incompressible chunks raw, costing only the chunk header", () => {
    const raw = noise(SPILL_CHUNK_BYTES);
    const encoded = encodeSpill(raw, "lz4");
    expect(encoded.length).toBe(raw.length + 9 + 5);
    expect(decodeSpill(encoded)).toEqual(raw);
  });

  it("rejects truncated, mislabeled and unknown-version blobs", () => {
    const encoded = encodeSpill(repeating(1000), "lz4");
    expect(() => decodeSpill(encoded.subarray(0, 4))).toThrow(RangeError);
    expect(() => decodeSpill(encoded.subarray(0, encoded.length - 1))).toThrow();
    const badVersion = encoded.slice();
    badVersion[0] = 99;
    expect(() => decodeSpill(badVersion)).toThrow(RangeError);
    const extra = new Uint8Array(encoded.length + 1);
    extra.set(encoded);
    expect(() => decodeSpill(extra)).toThrow(RangeError);
  });
});
