// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundledComponents, requiresNotice, unclassifiedLicenses } from "./open-source-licenses";
import {
  installedRustc,
  RUST_STD_LICENSES_DIR,
  readRustStdManifest,
  rustStdComponents,
  rustStdWarning,
} from "./rust-std";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const manifest = readRustStdManifest(APP_DIR);

describe("the Rust standard library notices", () => {
  it("lists the standard library, compiler_builtins and the crates std links on wasm32", () => {
    expect(manifest.components.map((library) => `${library.name}@${library.version}`)).toEqual([
      `rust-std@${manifest.rustc}`,
      "compiler_builtins@0.1.160",
      "dlmalloc@0.2.14",
      "hashbrown@0.17.1",
    ]);
    for (const library of manifest.components) {
      expect(unclassifiedLicenses(library.license), library.name).toEqual([]);
      expect(requiresNotice(library.license), library.name).toBe(true);
      expect(library.source, library.name).toMatch(/^https:\/\//);
    }
  });

  it("passes on the MIT texts with their copyright lines, and libm's musl notice", () => {
    const components = rustStdComponents(APP_DIR);
    for (const component of components) {
      expect(component.kind).toBe("rust");
      expect(component.licenseText, component.name).toContain(
        "Permission is hereby granted, free of charge",
      );
      expect(component.licenseText, component.name).not.toContain("\r");
    }
    const byName = new Map(components.map((component) => [component.name, component]));
    expect(byName.get("rust-std")?.copyright).toBe("Copyright (c) The Rust Project Contributors");
    expect(byName.get("dlmalloc")?.copyright).toBe("Copyright (c) 2014 Alex Crichton");
    expect(byName.get("hashbrown")?.copyright).toBe("Copyright (c) 2016 Amanieu d'Antras");
    expect(byName.get("compiler_builtins")?.licenseText).toContain("Rich Felker");
  });

  it("keeps a license file only for a component in the manifest", () => {
    const dir = join(APP_DIR, RUST_STD_LICENSES_DIR);
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
      .map((path) => path.replaceAll("\\", "/"))
      .filter((path) => path.includes("/"));
    expect(files.sort()).toEqual(manifest.components.flatMap((c) => c.licenseFiles).sort());
    for (const file of files) {
      expect(readFileSync(join(dir, file), "utf8").length, file).toBeGreaterThan(500);
    }
  });

  it("is listed with the kernels' crates, and only when the build ships the kernels", () => {
    const kernels = ["C:/app/crates/opaint-cpu/pkg/opaint_cpu.js"];
    const names = (ids: string[]) =>
      bundledComponents(APP_DIR, ids)
        .filter((component) => component.kind === "rust")
        .map((component) => component.name);
    expect(names(kernels)).toEqual(expect.arrayContaining(["rust-std", "compiler_builtins"]));
    expect(names([])).toEqual([]);
  });

  it("warns when rustc is another release than the manifest's", () => {
    expect(rustStdWarning(manifest, manifest.rustc)).toBeUndefined();
    expect(rustStdWarning(manifest, undefined)).toBeUndefined();
    expect(rustStdWarning(manifest, "2.0.0")).toContain("rustc is 2.0.0");
  });

  it("matches the installed toolchain, when rustc can run", () => {
    const rustc = installedRustc();
    if (rustc === undefined) return;
    expect(rustc, "refresh licenses/rust-std for the new toolchain").toBe(manifest.rustc);
  });
});
