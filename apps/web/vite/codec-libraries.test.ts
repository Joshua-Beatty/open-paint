// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CODEC_LICENSES_DIR,
  codecLibraryComponents,
  codecLibraryShipped,
  readCodecLibraries,
} from "./codec-libraries";
import { requiresNotice, unclassifiedLicenses } from "./open-source-licenses";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));

/** The codec packages, as installed for the codecs workspace package that imports them. */
const CODECS_MODULES = join(APP_DIR, "..", "..", "packages", "codecs", "node_modules");

function packageDir(name: string): string {
  return join(CODECS_MODULES, name);
}

function wasmFilesIn(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".wasm") && !path.includes("node_modules"))
    .map((path) => path.replaceAll("\\", "/"));
}

const libraries = readCodecLibraries(APP_DIR);

/** The package of a loader path inside node_modules ("<package>/<file>"). */
function packageOf(module: string): string {
  const parts = module.split("/");
  return (parts[0]?.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)).join("/");
}

/** The libraries (name@version) a package's .wasm file contains, by the manifest. */
function librariesIn(pkg: string, wasm: string): string[] {
  const loader = `${pkg}/${wasm.replace(/\.wasm$/, ".js")}`;
  return libraries
    .filter((library) => library.modules.includes(loader))
    .map((library) => `${library.name}@${library.version}`)
    .sort();
}

describe("the codec library manifest", () => {
  it("gives each library a name, version, classified license, sources and its copied license text", () => {
    expect(libraries.length).toBeGreaterThan(0);
    for (const library of libraries) {
      for (const field of ["name", "title", "version", "license", "url", "source"] as const) {
        expect(library[field], `${library.name} ${field}`).not.toBe("");
      }
      expect(library.source, library.name).toMatch(/^https:\/\//);
      expect(unclassifiedLicenses(library.license), library.name).toEqual([]);
      expect(requiresNotice(library.license), library.name).toBe(true);
      const text = readFileSync(join(APP_DIR, CODEC_LICENSES_DIR, library.licenseFile), "utf8");
      expect(text.length, library.name).toBeGreaterThan(500);
      expect(library.modules.length, library.name).toBeGreaterThan(0);
      for (const module of library.modules) {
        expect(existsSync(join(CODECS_MODULES, module)), `${library.name} ${module}`).toBe(true);
      }
    }
  });

  it("names the libraries of every .wasm in the codec packages", () => {
    const packages = [
      ...new Set(libraries.flatMap((library) => library.modules.map(packageOf))),
    ].sort();
    expect(packages).toEqual(["@jsquash/avif", "@jsquash/jxl", "@jsquash/webp", "lcms-wasm"]);
    const found: Record<string, string[]> = {};
    for (const pkg of packages) {
      for (const wasm of wasmFilesIn(packageDir(pkg))) {
        found[`${pkg}/${wasm}`] = librariesIn(pkg, wasm);
      }
    }
    // Emscripten's runtime and musl libc, at the Emscripten release each codec was built with.
    const em2 = ["emscripten@2.0.23", "musl@1.1.15"];
    const em3 = ["emscripten@3.1.57", "musl@1.2.5"];
    const avif = ["libaom@3.7.0", "libavif@1.0.1"];
    const sharpyuv = "libsharpyuv@1.3.1+e2c8587";
    const jxl = [
      "brotli@1.0.7+35ef5c5",
      ...em2,
      "highway@0.15.0+e69083a",
      "libjxl@0.7.0-dev+9f54464",
      "skcms@git+6437475",
    ].sort();
    const webp = [...em2, "libwebp@1.1.0+d2e245e"].sort();
    expect(found).toEqual({
      "@jsquash/avif/codec/dec/avif_dec.wasm": [...em3, ...avif].sort(),
      "@jsquash/avif/codec/enc/avif_enc.wasm": [...em3, ...avif, sharpyuv].sort(),
      "@jsquash/avif/codec/enc/avif_enc_mt.wasm": [...em3, ...avif, sharpyuv].sort(),
      "@jsquash/jxl/codec/dec/jxl_dec.wasm": jxl,
      "@jsquash/jxl/codec/enc/jxl_enc.wasm": jxl,
      "@jsquash/jxl/codec/enc/jxl_enc_mt.wasm": jxl,
      "@jsquash/jxl/codec/enc/jxl_enc_mt_simd.wasm": jxl,
      "@jsquash/webp/codec/dec/webp_dec.wasm": webp,
      "@jsquash/webp/codec/enc/webp_enc.wasm": webp,
      "@jsquash/webp/codec/enc/webp_enc_simd.wasm": webp,
      "lcms-wasm/dist/lcms.wasm": ["Little-CMS@2.16+c2a5401", "emscripten@3.1", "musl@1.2"],
    });
  });

  it("keeps a license file only for a library in the manifest", () => {
    const dir = join(APP_DIR, CODEC_LICENSES_DIR);
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
      .map((path) => path.replaceAll("\\", "/"))
      .filter((path) => path.includes("/"));
    expect(files.sort()).toEqual(
      [...new Set(libraries.map((library) => library.licenseFile))].sort(),
    );
  });
});

describe("which codec libraries the build ships", () => {
  const store = "C:\\app\\node_modules\\.pnpm\\@jsquash+avif@2.1.1\\node_modules\\@jsquash\\avif";

  it("lists a library when the build loads the WebAssembly loader of a .wasm that contains it", () => {
    const libavif = libraries.find((library) => library.name === "libavif");
    const sharpyuv = libraries.find((library) => library.name === "libsharpyuv");
    if (libavif === undefined || sharpyuv === undefined) throw new Error("manifest changed");
    const decoder = [`${store}\\codec\\dec\\avif_dec.js?worker_file`];
    expect(codecLibraryShipped(libavif, decoder)).toBe(true);
    expect(codecLibraryShipped(sharpyuv, decoder)).toBe(false);
    expect(codecLibraryShipped(sharpyuv, [`${store}\\codec\\enc\\avif_enc.js`])).toBe(true);
    expect(codecLibraryShipped(libavif, [`${store}\\decode.js`])).toBe(false);
  });

  it("gives the shipped libraries their copied license texts, and all of them without a module list", () => {
    const decoder = join(packageDir("@jsquash/avif"), "codec", "dec", "avif_dec.js");
    const shipped = codecLibraryComponents(APP_DIR, [decoder]);
    expect(shipped.map((component) => `${component.name}@${component.version}`)).toEqual([
      "libavif@1.0.1",
      "libaom@3.7.0",
      "emscripten@3.1.57",
      "musl@1.2.5",
    ]);
    const [libavif] = shipped;
    expect(libavif).toMatchObject({ kind: "codec", version: "1.0.1", license: "BSD-2-Clause" });
    expect(libavif?.copyright).toContain("Copyright 2019 Joe Drago");
    expect(libavif?.licenseText).not.toContain("\r");
    const all = codecLibraryComponents(APP_DIR).map((component) => component.name);
    expect(all).toEqual(libraries.map((library) => library.name));
  });

  it("gives a copyright line to every library, from its text or the manifest", () => {
    for (const component of codecLibraryComponents(APP_DIR)) {
      expect(component.copyright, component.name).toMatch(/Copyright/);
    }
  });
});
