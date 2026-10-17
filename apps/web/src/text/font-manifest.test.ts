// @vitest-environment node
/// <reference types="node" />
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundledFontModule, missingFontFiles, upstreamFontFile } from "../../vite/bundled-fonts";
import {
  readUpstreamFonts,
  UPSTREAM_FONTS_FOLDER,
  type UpstreamFontFamily,
  upstreamFontComponents,
} from "../../vite/upstream-fonts";
import { bundledFamilies } from "./bundled-fonts";
import {
  BUNDLED_FONT_SPECS,
  type BundledFontSpec,
  bundledFontFiles,
  COMPLETE,
  fontFilePath,
  isUpstreamFontPath,
  SUBSET_RANGES,
} from "./font-manifest";
import { resolveFamily } from "./text-options";

const require = createRequire(import.meta.url);
const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));
const FONTS_DIR = join(APP_DIR, UPSTREAM_FONTS_FOLDER);

interface FontMetadata {
  readonly license: { readonly type: string };
  readonly variable: false | { readonly wght?: { readonly min: string; readonly max: string } };
}

function metadataOf(name: string): FontMetadata {
  return JSON.parse(readFileSync(require.resolve(`${name}/metadata.json`), "utf8")) as FontMetadata;
}

function licenseOf(name: string): string {
  return readFileSync(require.resolve(`${name}/LICENSE`), "utf8");
}

const appManifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { readonly dependencies: Readonly<Record<string, string>> };

const upstreamSpecs = BUNDLED_FONT_SPECS.filter((spec) => isUpstreamFontPath(spec.package));
const packageSpecs = BUNDLED_FONT_SPECS.filter((spec) => !isUpstreamFontPath(spec.package));
const packages = [...new Set(packageSpecs.map((spec) => spec.package))];
const upstreamFonts = readUpstreamFonts(APP_DIR);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Why an upstream family may not ship under its Reserved Font Name: a file that is not the
 * recorded upstream file byte for byte, a file the manifest does not record, or a license that
 * does not reserve the family's name.
 */
function upstreamProblems(
  spec: BundledFontSpec,
  family: UpstreamFontFamily | undefined,
  read: (file: string) => Uint8Array,
): string[] {
  if (family === undefined) return [`${spec.family} has no upstream record`];
  const problems: string[] = [];
  if (spec.subsets.join() !== COMPLETE) problems.push(`${spec.family} is not complete files`);
  const recorded = new Map(family.files.map((file) => [`/fonts/${file.file}`, file]));
  for (const face of spec.faces) {
    const path = fontFilePath(spec, face, COMPLETE);
    const entry = recorded.get(path);
    if (entry === undefined) {
      problems.push(`${path} has no upstream record`);
      continue;
    }
    const bytes = read(entry.file);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      problems.push(`${path} is not the upstream file`);
    }
  }
  const license = new TextDecoder().decode(read(family.license.file));
  if (!license.includes("SIL OPEN FONT LICENSE Version 1.1")) problems.push("not OFL 1.1");
  if (!new RegExp(`Reserved Font Name "${family.reservedFontName}"`).test(license)) {
    problems.push(`${spec.family}'s license does not reserve "${family.reservedFontName}"`);
  }
  if (family.reservedFontName !== spec.family) problems.push(`${spec.family} is renamed`);
  return problems;
}

const readUpstream = (file: string) => readFileSync(join(FONTS_DIR, file));

describe("bundled fonts (WEB-FONT-01, PRD-12)", () => {
  it("has one entry per family, the default among them", () => {
    const families = BUNDLED_FONT_SPECS.map((spec) => spec.family);
    expect(families).toHaveLength(34);
    expect(new Set(families).size).toBe(families.length);
    expect(families).toContain("Noto Sans");
  });

  it("ships every file it lists", () => {
    for (const path of bundledFontFiles()) {
      const file = isUpstreamFontPath(path)
        ? upstreamFontFile(APP_DIR, path)
        : require.resolve(path);
      expect(existsSync(file), path).toBe(true);
    }
    expect(missingFontFiles(APP_DIR)).toEqual([]);
  });

  it("bundles only pinned dependencies, so the notices list each package with its license", () => {
    for (const name of packages)
      expect(appManifest.dependencies[name], name).toMatch(/^\d+\.\d+\.\d+$/);
    const fontDependencies = Object.keys(appManifest.dependencies).filter((name) =>
      name.startsWith("@fontsource"),
    );
    expect(fontDependencies.sort()).toEqual([...packages].sort());
  });

  it("bundles a font with a Reserved Font Name only as its upstream's unmodified, complete files", () => {
    expect(upstreamSpecs.map((spec) => spec.family).sort()).toEqual([
      "Lobster",
      "Lora",
      "Merriweather",
      "Playfair Display",
    ]);
    expect(upstreamFonts.map((family) => family.family).sort()).toEqual(
      upstreamSpecs.map((spec) => spec.family).sort(),
    );
    for (const spec of upstreamSpecs) {
      const family = upstreamFonts.find((entry) => entry.family === spec.family);
      expect(upstreamProblems(spec, family, readUpstream), spec.family).toEqual([]);
      expect(family?.commit, spec.family).toMatch(/^[0-9a-f]{40}$/);
      expect(family?.repository, spec.family).toMatch(/^https:\/\/github\.com\//);
    }
    // The folder holds only recorded files: the fonts and their license texts.
    const recorded = upstreamFonts.flatMap((family) => [
      family.license.file,
      ...family.files.map((file) => file.file),
    ]);
    const present = readdirSync(FONTS_DIR, { recursive: true, encoding: "utf8" })
      .map((path) => path.replaceAll("\\", "/"))
      .filter((path) => path.includes("/"));
    expect(present.sort()).toEqual(recorded.sort());
  });

  it("refuses an upstream font file that was changed, such as a subset", () => {
    const spec = upstreamSpecs.find((entry) => entry.family === "Lobster");
    const family = upstreamFonts.find((entry) => entry.family === "Lobster");
    if (spec === undefined || family === undefined) throw new Error("no Lobster");
    const subset = (file: string) => {
      const bytes = readUpstream(file);
      return file.endsWith(".otf") ? bytes.subarray(0, bytes.length - 1024) : bytes;
    };
    expect(upstreamProblems(spec, family, subset)).toEqual([
      "/fonts/lobster/Lobster-Regular.otf is not the upstream file",
    ]);
    expect(upstreamProblems({ ...spec, subsets: ["latin"] }, family, readUpstream)).toEqual([
      "Lobster is not complete files",
    ]);
    expect(upstreamProblems({ ...spec, family: "Lobster Two" }, undefined, readUpstream)).toEqual([
      "Lobster Two has no upstream record",
    ]);
  });

  it("loads an upstream face as one complete file, and a saved Lobster setting resolves to Lobster", () => {
    const urls = bundledFontFiles().map((path) => `/${path}`);
    const families = bundledFamilies(BUNDLED_FONT_SPECS, urls);
    const lobster = families.find((family) => family.family === "Lobster");
    expect(lobster?.faces).toEqual([
      { weight: 400, style: "normal", url: "//fonts/lobster/Lobster-Regular.otf" },
    ]);
    const lora = families.find((family) => family.family === "Lora");
    expect(lora?.faces.map((face) => [face.weight, face.style, face.unicodeRange])).toEqual([
      [[400, 700], "normal", undefined],
      [[400, 700], "italic", undefined],
    ]);
    const names = families.map((family) => family.family);
    expect(resolveFamily("Lobster", names, "Noto Sans")).toBe("Lobster");
    expect(resolveFamily("Playfair Display", names, "Noto Sans")).toBe("Playfair Display");
  });

  it("lists each upstream family in the notices with its version and OFL text", () => {
    const components = upstreamFontComponents(APP_DIR);
    expect(components.map((component) => `${component.name} ${component.version}`)).toEqual([
      "Lobster 2.100",
      "Lora 3.008",
      "Merriweather 2.200",
      "Playfair Display 1.202",
    ]);
    for (const component of components) {
      expect(component).toMatchObject({ kind: "font", license: "OFL-1.1" });
      expect(component.copyright, component.name).toContain("Reserved Font Name");
      expect(component.licenseText, component.name).toContain("SIL OPEN FONT LICENSE Version 1.1");
    }
  });

  it("bundles only OFL 1.1 or Apache 2.0 fonts, and no subset with a Reserved Font Name", () => {
    for (const name of packages) {
      const license = metadataOf(name).license.type;
      expect(["OFL-1.1", "Apache-2.0"], name).toContain(license);
      const text = licenseOf(name);
      if (license === "OFL-1.1") {
        expect(text, name).toContain("SIL OPEN FONT LICENSE Version 1.1");
        // The copyright lines come before the license itself, which defines the term.
        const notice = text.split("This Font Software is licensed")[0] ?? "";
        expect(notice, name).toMatch(/Copyright/);
        expect(notice, name).not.toMatch(/Reserved Font Name/i);
      } else {
        expect(text, name).toContain("Apache License");
        expect(text, name).toContain("Version 2.0");
      }
    }
  });

  it("gives each variable face the weight range of its font", () => {
    for (const spec of packageSpecs) {
      const metadata = metadataOf(spec.package);
      for (const face of spec.faces) {
        if (typeof face.weight === "number") continue;
        const wght = metadata.variable === false ? undefined : metadata.variable.wght;
        expect(wght, spec.family).toBeDefined();
        expect(face.weight, spec.family).toEqual([Number(wght?.min), Number(wght?.max)]);
      }
    }
  });

  it("uses the subset ranges of the packages", () => {
    for (const name of packages) {
      const ranges = JSON.parse(
        readFileSync(require.resolve(`${name}/unicode.json`), "utf8"),
      ) as Record<string, string>;
      expect(ranges.latin, name).toBe(SUBSET_RANGES.latin);
      if (ranges["latin-ext"] !== undefined)
        expect(ranges["latin-ext"]).toBe(SUBSET_RANGES["latin-ext"]);
    }
  });

  it("maps each face and subset to its built URL, and refuses a file that is not bundled", () => {
    const [spec] = BUNDLED_FONT_SPECS;
    if (spec === undefined) throw new Error("no fonts");
    const urls = bundledFontFiles([spec]).map((path) => `/${path}`);
    const [family] = bundledFamilies([spec], urls);
    const [face] = spec.faces;
    if (face === undefined) throw new Error("no faces");
    expect(family?.family).toBe(spec.family);
    expect(family?.faces[0]).toEqual({
      weight: face.weight,
      style: face.style,
      url: `/${fontFilePath(spec, face, "latin")}`,
      unicodeRange: SUBSET_RANGES.latin,
    });
    expect(family?.faces.map((face) => face.url)).toEqual(urls);
    expect(() => bundledFamilies([spec], urls.slice(1))).toThrow("is not bundled");
    expect(() => bundledFamilies([spec], [...urls, "/extra.woff2"])).toThrow("do not match");
  });

  it("imports each file as a separate asset, in manifest order", () => {
    const source = bundledFontModule([
      "@fontsource/a/files/a.woff2",
      "@fontsource/b/files/b.woff2",
    ]);
    expect(source).toContain('import f0 from "@fontsource/a/files/a.woff2?no-inline";');
    expect(source).toContain("export default [f0, f1];");
  });
});
