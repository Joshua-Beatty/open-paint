// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requiresNotice, unclassifiedLicenses } from "./open-source-licenses";
import {
  type CargoMetadata,
  type CargoPackage,
  cargoCrateComponents,
  cargoLockHash,
  cargoMetadataArgs,
  cargoTreeArgs,
  chooseLicenseText,
  crateComponent,
  crateLicense,
  cratesDirOf,
  isProcMacro,
  type LicenseFile,
  licensesOfFile,
  parseCargoTree,
  RUST_CRATES_SNAPSHOT,
  readRustCratesSnapshot,
  rustCrateComponents,
  shippedCrates,
  WASM_TARGET,
} from "./rust-crates";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));

const hasCargo = (() => {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "opaint-crates-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function pkg(name: string, version: string, overrides: Partial<CargoPackage> = {}): CargoPackage {
  return {
    id: `registry+https://github.com/rust-lang/crates.io-index#${name}@${version}`,
    name,
    version,
    license: "MIT",
    license_file: null,
    repository: null,
    homepage: null,
    manifest_path: join(root, `${name}-${version}`, "Cargo.toml"),
    targets: [{ kind: ["lib"] }],
    ...overrides,
  };
}

function file(name: string, text: string): LicenseFile {
  return { name, text, ids: licensesOfFile(name, text) };
}

const MIT_TEXT =
  "MIT License\n\nCopyright (c) 2020 Ann\n\nPermission is hereby granted, free of charge";
const APACHE_TEXT = "Apache License\nVersion 2.0, January 2004\nhttp://www.apache.org/licenses/";
const BSD3_TEXT =
  "Copyright (c) 2016 Dropbox\nRedistribution and use in source and binary forms\nNeither the name of the copyright holder";

describe("which crates the WebAssembly links", () => {
  it("asks Cargo for the kernels' crate on the WebAssembly target, normal dependencies only, without procedural macros", () => {
    const args = cargoTreeArgs("crates");
    const flagValue = (flag: string) => args[args.indexOf(flag) + 1];
    expect(flagValue("--package")).toBe("opaint-cpu");
    expect(flagValue("--target")).toBe(WASM_TARGET);
    expect(flagValue("--edges")).toBe("normal,no-proc-macro");
    expect(args).toContain("--locked");
    expect(cargoMetadataArgs("crates")).toContain(WASM_TARGET);
  });

  it("reads each crate of the tree once, without the repeat marks and source paths", () => {
    const output = [
      "opaint-cpu v0.0.0 (C:\\repo\\crates\\opaint-cpu)",
      "rav1e v0.8.1",
      "v_frame v0.3.9",
      "rav1e v0.8.1 (*)",
      "miniz_oxide v0.8.9",
      "miniz_oxide v0.9.1",
      "",
    ].join("\r\n");
    expect(parseCargoTree(output)).toEqual([
      { name: "opaint-cpu", version: "0.0.0" },
      { name: "rav1e", version: "0.8.1" },
      { name: "v_frame", version: "0.3.9" },
      { name: "miniz_oxide", version: "0.8.9" },
      { name: "miniz_oxide", version: "0.9.1" },
    ]);
  });

  it("leaves out the workspace's own crate and any procedural macro, and sorts by name", () => {
    const own = pkg("opaint-cpu", "0.0.0", { id: "path+file:///repo/crates/opaint-cpu#0.0.0" });
    const macro = pkg("thiserror-impl", "2.0.21", { targets: [{ kind: ["proc-macro"] }] });
    const metadata: CargoMetadata = {
      packages: [own, macro, pkg("zerocopy", "0.8.62"), pkg("png", "0.18.1")],
      workspace_members: [own.id],
    };
    const tree = parseCargoTree(
      "opaint-cpu v0.0.0 (/repo)\nzerocopy v0.8.62\nthiserror-impl v2.0.21\npng v0.18.1\n",
    );
    expect(isProcMacro(macro)).toBe(true);
    expect(shippedCrates(tree, metadata).map((p) => p.name)).toEqual(["png", "zerocopy"]);
    expect(() => shippedCrates([{ name: "gone", version: "1.0.0" }], metadata)).toThrow(
      "cargo metadata does not list gone 1.0.0",
    );
  });
});

describe("a crate's license text", () => {
  it("reads the license from the file name, else its text, telling the two BSD licenses apart", () => {
    expect([...licensesOfFile("LICENSE-MIT", "")]).toEqual(["MIT"]);
    expect([...licensesOfFile("LICENSE-APACHE", "")]).toEqual(["Apache-2.0"]);
    expect([...licensesOfFile("LICENSE", APACHE_TEXT)]).toEqual(["Apache-2.0"]);
    expect([...licensesOfFile("LICENSE.md", BSD3_TEXT)]).toEqual(["BSD-3-Clause"]);
    expect([
      ...licensesOfFile("COPYING", "Redistribution and use in source and binary forms"),
    ]).toEqual(["BSD-2-Clause"]);
    expect([...licensesOfFile("LICENSE-IJG", "")]).toEqual(["IJG"]);
  });

  it("passes on the shortest text of a choice, every text of licenses that apply together, and Apache's NOTICE", () => {
    const mit = file("LICENSE-MIT", MIT_TEXT);
    const apache = file("LICENSE-APACHE", APACHE_TEXT);
    const ijg = file("LICENSE-IJG", "Independent JPEG Group terms");
    const notice = file("NOTICE", "Notice of the Apache-licensed work");
    expect(chooseLicenseText("MIT OR Apache-2.0", [apache, mit])).toBe(MIT_TEXT);
    expect(chooseLicenseText("Apache-2.0 OR MIT", [apache, mit, notice])).toBe(MIT_TEXT);
    expect(chooseLicenseText("(MIT OR Apache-2.0) AND IJG", [apache, ijg, mit])).toBe(
      `${MIT_TEXT}\n\nIndependent JPEG Group terms`,
    );
    expect(chooseLicenseText("Apache-2.0", [apache, notice])).toBe(
      `${APACHE_TEXT}\n\nNotice of the Apache-licensed work`,
    );
    // A license that asks for no notice needs no text, so the other one is passed on.
    expect(chooseLicenseText("0BSD OR MIT OR Apache-2.0", [apache, mit])).toBe(MIT_TEXT);
    // Only the Apache text is there, so that alternative is taken.
    expect(chooseLicenseText("MIT OR Apache-2.0", [apache])).toBe(APACHE_TEXT);
    // No alternative has all its texts: every file is passed on rather than none.
    expect(chooseLicenseText("BSD-3-Clause", [mit, apache])).toBe(`${MIT_TEXT}\n\n${APACHE_TEXT}`);
  });

  it("reads Cargo's old slash form as a choice", () => {
    expect(crateLicense(pkg("quick-error", "2.0.1", { license: "MIT/Apache-2.0" }))).toBe(
      "MIT OR Apache-2.0",
    );
    expect(crateLicense(pkg("odd", "1.0.0", { license: null, license_file: "LICENSE.txt" }))).toBe(
      "SEE LICENSE FILE",
    );
  });

  it("makes a component from the crate's source folder, or the copied text for a crate that ships none", () => {
    const dir = join(root, "x-1.0.0");
    mkdirSync(dir);
    writeFileSync(join(dir, "LICENSE-MIT"), `${MIT_TEXT}\r\n`);
    writeFileSync(join(dir, "LICENSE-APACHE"), APACHE_TEXT);
    writeFileSync(join(dir, "README.md"), "readme");
    const component = crateComponent(
      pkg("x", "1.0.0", {
        license: "MIT OR Apache-2.0",
        repository: "https://github.com/o/x.git",
      }),
    );
    expect(component).toEqual({
      name: "x",
      title: "x",
      kind: "rust",
      version: "1.0.0",
      license: "MIT OR Apache-2.0",
      url: "https://github.com/o/x",
      copyright: "Copyright (c) 2020 Ann",
      licenseText: MIT_TEXT,
    });

    mkdirSync(join(root, "y-2.0.0"));
    const copies = join(root, "copies");
    mkdirSync(join(copies, "y-2.0.0"), { recursive: true });
    writeFileSync(join(copies, "y-2.0.0", "LICENSE"), BSD3_TEXT);
    const y = pkg("y", "2.0.0", { license: "BSD-3-Clause" });
    expect(crateComponent(y).licenseText).toBe("");
    expect(crateComponent(y, copies)).toMatchObject({
      url: "https://crates.io/crates/y",
      licenseText: BSD3_TEXT,
      copyright: "Copyright (c) 2016 Dropbox",
    });
  });
});

describe("where Cargo cannot run", () => {
  it("uses the checked-in list, and warns when it does not match Cargo.lock", () => {
    const appDir = join(root, "apps", "web");
    mkdirSync(join(appDir, "licenses"), { recursive: true });
    mkdirSync(join(root, "crates"));
    writeFileSync(join(root, "crates", "Cargo.lock"), "version = 4\r\n");
    const crate = crateComponent(pkg("png", "0.18.1"));
    const write = (cargoLock: string) =>
      writeFileSync(
        join(appDir, RUST_CRATES_SNAPSHOT),
        JSON.stringify({ cargoLock, crates: [crate] }),
      );
    const path = process.env.PATH;
    process.env.PATH = "";
    try {
      write(cargoLockHash(join(root, "crates")));
      const current = rustCrateComponents(appDir);
      expect(current.crates).toEqual([crate]);
      expect(current.warning).toMatch(/^Cargo could not list the Rust crates .*is used\.$/);
      const other = join(root, "other", "web");
      mkdirSync(join(other, "licenses"), { recursive: true });
      writeFileSync(
        join(other, RUST_CRATES_SNAPSHOT),
        JSON.stringify({ cargoLock: "an older lock", crates: [] }),
      );
      expect(rustCrateComponents(other).warning).toMatch(/does not match Cargo\.lock\.$/);
    } finally {
      process.env.PATH = path;
    }
  });
});

describe("the crates of the real build", () => {
  it("has a checked-in list made from the current Cargo.lock", () => {
    expect(readRustCratesSnapshot(APP_DIR).cargoLock).toBe(cargoLockHash(cratesDirOf(APP_DIR)));
  });

  it.skipIf(!hasCargo)(
    "lists the linked crates with their licenses, and no build, test or macro crate",
    () => {
      const crates = cargoCrateComponents(APP_DIR);
      const names = crates.map((crate) => crate.name);
      for (const name of [
        "rav1e",
        "png",
        "gif",
        "tiff",
        "jxl-oxide",
        "miniz_oxide",
        "wasm-bindgen",
      ]) {
        expect(names).toContain(name);
      }
      expect(names).not.toContain("opaint-cpu");
      // A test dependency, build-script dependencies and the compiler-side macro crates.
      for (const name of ["avif-parse", "autocfg", "rustversion", "built", "syn", "quote"]) {
        expect(names).not.toContain(name);
      }
      const metadata = JSON.parse(
        execFileSync("cargo", cargoMetadataArgs(cratesDirOf(APP_DIR)), {
          encoding: "utf8",
          maxBuffer: 256 * 1024 * 1024,
          windowsHide: true,
        }),
      ) as CargoMetadata;
      const macros = metadata.packages.filter(isProcMacro).map((p) => p.name);
      expect(macros).toContain("wasm-bindgen-macro");
      for (const macro of macros) expect(names).not.toContain(macro);
      for (const crate of crates) {
        expect(unclassifiedLicenses(crate.license), crate.name).toEqual([]);
        if (requiresNotice(crate.license)) {
          expect(crate.licenseText.length, crate.name).toBeGreaterThan(500);
        }
      }
    },
  );

  it.skipIf(!hasCargo)("has a checked-in list equal to what Cargo gives now", () => {
    expect(readRustCratesSnapshot(APP_DIR).crates).toEqual(cargoCrateComponents(APP_DIR));
  });
});
