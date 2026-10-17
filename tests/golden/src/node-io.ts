/// <reference types="node" />
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { deflateSync, inflateSync } from "node:zlib";
import {
  type Deflate,
  decodePng,
  encodePng,
  type Inflate,
  type RgbaImage,
} from "@openpaint/codecs";

/** The `tests/golden` package root; golden paths in `cases.ts` are relative to it. */
const ROOT = new URL("../", import.meta.url);

const deflate: Deflate = (data) => new Uint8Array(deflateSync(data));
const inflate: Inflate = async (data) => new Uint8Array(inflateSync(data));

export async function readReference(path: string): Promise<RgbaImage> {
  return decodePng(new Uint8Array(await readFile(new URL(path, ROOT))), inflate);
}

export async function writeReference(path: string, image: RgbaImage): Promise<void> {
  const target = new URL(path, ROOT);
  await mkdir(new URL(".", target), { recursive: true });
  await writeFile(target, encodePng(image, deflate));
}

/** Saves a mismatching output next to the goldens (`tests/golden/actual/`, git-ignored). */
export async function writeActual(name: string, image: RgbaImage): Promise<string> {
  const path = `actual/${name}.png`;
  await writeReference(path, image);
  return new URL(path, ROOT).pathname;
}
