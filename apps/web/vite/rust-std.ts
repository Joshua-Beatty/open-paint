import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { copyrightOf, type OpenSourceComponent } from "./open-source-licenses.ts";

/** The copied license texts of the Rust toolchain's linked libraries and their manifest. */
export const RUST_STD_LICENSES_DIR = join("licenses", "rust-std");

/** A part of the Rust toolchain that rustc links into the WebAssembly kernels. */
export interface RustStdLibrary {
  readonly name: string;
  readonly title: string;
  readonly version: string;
  readonly license: string;
  readonly url: string;
  /** Where the license texts were copied from. */
  readonly source: string;
  /** The copied license texts, relative to the manifest, passed on together. */
  readonly licenseFiles: readonly string[];
}

export interface RustStdManifest {
  /** The rustc release the list is for. */
  readonly rustc: string;
  /** The rust-lang/rust commit of that release. */
  readonly commit: string;
  readonly components: readonly RustStdLibrary[];
}

export function readRustStdManifest(appDir: string): RustStdManifest {
  const file = join(appDir, RUST_STD_LICENSES_DIR, "manifest.json");
  return JSON.parse(readFileSync(file, "utf8")) as RustStdManifest;
}

/** The release of the installed rustc ("1.99.0"), or undefined when it cannot run. */
export function installedRustc(): string | undefined {
  try {
    const output = execFileSync("rustc", ["-vV"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return /^release:\s*(\S+)/m.exec(output)?.[1];
  } catch {
    return undefined;
  }
}

/** Why the manifest may not match the toolchain that built the kernels, or undefined. */
export function rustStdWarning(manifest: RustStdManifest, rustc: string | undefined) {
  if (rustc === undefined) return undefined;
  if (rustc === manifest.rustc) return undefined;
  return `${join(RUST_STD_LICENSES_DIR, "manifest.json")} lists the Rust ${manifest.rustc} standard library, but rustc is ${rustc}; check its library/Cargo.lock and copy the license texts again.`;
}

/** The Rust standard library and the crates it links into the kernels, with their texts. */
export function rustStdComponents(appDir: string): OpenSourceComponent[] {
  const manifest = readRustStdManifest(appDir);
  return manifest.components.map((library) => {
    const licenseText = library.licenseFiles
      .map((file) =>
        readFileSync(join(appDir, RUST_STD_LICENSES_DIR, file), "utf8")
          .replace(/\r\n/g, "\n")
          .trimEnd(),
      )
      .join("\n\n");
    return {
      name: library.name,
      title: library.title,
      kind: "rust",
      version: library.version,
      license: library.license,
      url: library.url,
      copyright: copyrightOf(licenseText),
      licenseText,
    };
  });
}
