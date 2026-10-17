import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  copyrightOf,
  licenseChoices,
  NOTICE_FREE_LICENSES,
  type OpenSourceComponent,
} from "./open-source-licenses.ts";

/** The crate the WebAssembly kernels are built from (crates/opaint-cpu). */
export const WASM_CRATE = "opaint-cpu";

/** The target the WebAssembly kernels are built for. */
export const WASM_TARGET = "wasm32-unknown-unknown";

/** The Cargo workspace, relative to the app. */
const CRATES_DIR = join("..", "..", "crates");

/** The checked-in crate list, used where Cargo cannot be run; relative to the app. */
export const RUST_CRATES_SNAPSHOT = join("licenses", "rust-crates.json");

/**
 * The arguments of the `cargo tree` call that lists the crates linked into the WebAssembly: the
 * kernels' crate for its target, through normal dependencies only. Build scripts' and test
 * dependencies are not linked, and neither are procedural macros (or what only they use), which run
 * in the compiler. `cargo tree` resolves features as `cargo build` does, so a feature that only a
 * test dependency turns on adds nothing.
 */
export function cargoTreeArgs(cratesDir: string): string[] {
  return [
    "tree",
    "--manifest-path",
    join(cratesDir, "Cargo.toml"),
    "--package",
    WASM_CRATE,
    "--target",
    WASM_TARGET,
    "--edges",
    "normal,no-proc-macro",
    "--prefix",
    "none",
    "--format",
    "{p}",
    "--locked",
  ];
}

/** The arguments of the `cargo metadata` call that gives each crate's license and source folder. */
export function cargoMetadataArgs(cratesDir: string): string[] {
  return [
    "metadata",
    "--manifest-path",
    join(cratesDir, "Cargo.toml"),
    "--format-version",
    "1",
    "--filter-platform",
    WASM_TARGET,
    "--locked",
  ];
}

export interface CrateRef {
  readonly name: string;
  readonly version: string;
}

/** The crates of `cargo tree --prefix none --format {p}` output, each once, in order. */
export function parseCargoTree(output: string): CrateRef[] {
  const found = new Map<string, CrateRef>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+) v(\S+)/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      found.set(`${match[1]}@${match[2]}`, { name: match[1], version: match[2] });
    }
  }
  return [...found.values()];
}

/** The parts of a `cargo metadata` package this list uses. */
export interface CargoPackage {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly license: string | null;
  readonly license_file: string | null;
  readonly repository: string | null;
  readonly homepage: string | null;
  readonly manifest_path: string;
  readonly targets: readonly { readonly kind: readonly string[] }[];
}

export interface CargoMetadata {
  readonly packages: readonly CargoPackage[];
  readonly workspace_members: readonly string[];
}

/** Whether a package is a procedural macro, which runs in the compiler and is not linked. */
export function isProcMacro(pkg: CargoPackage): boolean {
  return pkg.targets.some((target) => target.kind.includes("proc-macro"));
}

/**
 * The packages of the crates linked into the WebAssembly: the crates `cargo tree` lists, without
 * the workspace's own crates and, as a second guard, without procedural macros.
 */
export function shippedCrates(tree: readonly CrateRef[], metadata: CargoMetadata): CargoPackage[] {
  const workspace = new Set(metadata.workspace_members);
  return tree
    .map(({ name, version }) => {
      const pkg = metadata.packages.find((p) => p.name === name && p.version === version);
      if (pkg === undefined) throw new Error(`cargo metadata does not list ${name} ${version}.`);
      return pkg;
    })
    .filter((pkg) => !workspace.has(pkg.id) && !isProcMacro(pkg))
    .sort((a, b) => (a.name === b.name ? cmp(a.version, b.version) : cmp(a.name, b.name)));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A crate's license files: LICENSE, LICENCE, COPYING, NOTICE and the like, with any suffix. */
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)([-._].*)?$/i;

/** The licenses a file name says it holds, as in LICENSE-MIT or LICENSE-APACHE. */
const NAMED_LICENSES: readonly (readonly [RegExp, string])[] = [
  [/apache/i, "Apache-2.0"],
  [/mit/i, "MIT"],
  [/zlib/i, "Zlib"],
  [/bsd/i, "BSD"],
  [/boost|bsl/i, "BSL-1.0"],
  [/isc/i, "ISC"],
  [/unicode/i, "Unicode-3.0"],
  [/ijg|jpeg/i, "IJG"],
];

/** The licenses a text holds, by words each one's text uses. */
const LICENSE_SIGNATURES: readonly (readonly [string, RegExp])[] = [
  ["Apache-2.0", /Apache License[\s,]+Version 2\.0, January 2004/i],
  ["MIT", /Permission is hereby granted, free of charge/i],
  ["BSD", /Redistribution and use in source and binary forms/i],
  ["Zlib", /provided ['‘]as-is['’], without any express or implied\s+warranty/i],
  ["ISC", /Permission to use, copy, modify, and\/or distribute this software for any/i],
  ["BSL-1.0", /Boost Software License/i],
  ["Unicode-3.0", /UNICODE LICENSE V3/i],
  ["IJG", /Independent JPEG Group/i],
];

/** The licenses a license file holds, from its name, else its text. */
export function licensesOfFile(fileName: string, text: string): Set<string> {
  const named = NAMED_LICENSES.filter(([pattern]) =>
    pattern.test(fileName.replace(/^licen[cs]e/i, "")),
  );
  const ids = new Set(
    named.length > 0
      ? named.map(([, id]) => id)
      : LICENSE_SIGNATURES.filter(([, pattern]) => pattern.test(text)).map(([id]) => id),
  );
  // The two BSD licenses differ by the clause on endorsement.
  if (ids.delete("BSD")) {
    ids.add(
      /Neither the name|names of (its|the) contributors/i.test(text)
        ? "BSD-3-Clause"
        : "BSD-2-Clause",
    );
  }
  return ids;
}

/** Which license of a choice to pass on, shortest text first. */
const PREFERENCE = [
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "Zlib",
  "BSD-3-Clause",
  "BSL-1.0",
  "Unicode-3.0",
  "IJG",
  "Apache-2.0",
];

function rank(id: string): number {
  const index = PREFERENCE.indexOf(id);
  return index < 0 ? PREFERENCE.length : index;
}

export interface LicenseFile {
  readonly name: string;
  readonly text: string;
  readonly ids: Set<string>;
}

/**
 * The license text to pass on for a license expression and the license files found: for a choice
 * ("MIT OR Apache-2.0"), the texts of the alternative whose licenses all have a file, preferring
 * the shorter texts; for licenses that apply together ("AND"), each one's text. Licenses that ask
 * for no notice need no text. Where no alternative has every text, all the files are passed on.
 * A NOTICE file goes with the Apache license, as its section 4(d) asks.
 */
export function chooseLicenseText(license: string, files: readonly LicenseFile[]): string {
  const licenseFiles = files.filter((file) => !/^notice/i.test(file.name));
  const notices = files.filter((file) => /^notice/i.test(file.name));
  const alternatives = licenseChoices(license)
    .map((choice) => choice.filter((id) => !NOTICE_FREE_LICENSES.has(id)))
    .filter((choice) => choice.length > 0)
    .map((choice) => ({
      choice,
      chosen: choice.map((id) => licenseFiles.find((file) => file.ids.has(id))),
      cost: choice.reduce((sum, id) => sum + rank(id), 0),
    }))
    .filter((alternative) => alternative.chosen.every((file) => file !== undefined))
    .sort((a, b) => a.cost - b.cost);
  const best = alternatives[0];
  const chosen = best === undefined ? licenseFiles : [...new Set(best.chosen)];
  const withNotice =
    best === undefined || best.choice.includes("Apache-2.0") ? [...chosen, ...notices] : chosen;
  return withNotice
    .filter((file): file is LicenseFile => file !== undefined)
    .map((file) => file.text)
    .join("\n\n");
}

function readText(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .trimEnd();
}

/**
 * License files for crates whose published package ships none, relative to the app: copied from
 * the crate's repository at the commit its .cargo_vcs_info.json names, in `<name>-<version>/`, so
 * they apply only to that version.
 */
export const CRATE_LICENSES_DIR = join("licenses", "crates");

function licenseFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => LICENSE_FILE.test(name))
    .sort()
    .map((name) => join(dir, name));
}

/**
 * The license files in a crate's source folder and the one its manifest names, else the copies
 * in `copiesDir` for the crate's version.
 */
export function licenseFilesOf(pkg: CargoPackage, copiesDir?: string): LicenseFile[] {
  const dir = dirname(pkg.manifest_path);
  const paths = licenseFilesIn(dir);
  if (pkg.license_file !== null) {
    const named = join(dir, pkg.license_file);
    if (!paths.includes(named) && existsSync(named)) paths.push(named);
  }
  if (paths.length === 0 && copiesDir !== undefined) {
    paths.push(...licenseFilesIn(join(copiesDir, `${pkg.name}-${pkg.version}`)));
  }
  return paths.map((path) => {
    const text = readText(path);
    const name = path.slice(dirname(path).length + 1);
    return { name, text, ids: licensesOfFile(name, text) };
  });
}

/** A crate's license as an SPDX expression: the old "MIT/Apache-2.0" form is a choice. */
export function crateLicense(pkg: CargoPackage): string {
  if (pkg.license === null) return pkg.license_file === null ? "UNKNOWN" : "SEE LICENSE FILE";
  return pkg.license.replace(/\s*\/\s*/g, " OR ");
}

/** One crate as a listed component, with the license text it passes on. */
export function crateComponent(pkg: CargoPackage, copiesDir?: string): OpenSourceComponent {
  const license = crateLicense(pkg);
  const licenseText = chooseLicenseText(license, licenseFilesOf(pkg, copiesDir));
  const url = (pkg.repository ?? pkg.homepage ?? "").replace(/\.git$/, "");
  return {
    name: pkg.name,
    title: pkg.name,
    kind: "rust",
    version: pkg.version,
    license,
    url: url === "" ? `https://crates.io/crates/${pkg.name}` : url,
    copyright: copyrightOf(licenseText),
    licenseText,
  };
}

function cargo(args: readonly string[]): string {
  return execFileSync("cargo", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

/** The crates linked into the WebAssembly, read from Cargo now. Throws when Cargo cannot run. */
export function cargoCrateComponents(appDir: string): OpenSourceComponent[] {
  const cratesDir = cratesDirOf(appDir);
  const tree = parseCargoTree(cargo(cargoTreeArgs(cratesDir)));
  const metadata = JSON.parse(cargo(cargoMetadataArgs(cratesDir))) as CargoMetadata;
  const copiesDir = join(appDir, CRATE_LICENSES_DIR);
  return shippedCrates(tree, metadata).map((pkg) => crateComponent(pkg, copiesDir));
}

/** The checked-in crate list: the components, and the Cargo.lock they were made from. */
export interface RustCratesSnapshot {
  /** The SHA-256 of Cargo.lock (with "\n" line ends) when the list was made. */
  readonly cargoLock: string;
  readonly crates: readonly OpenSourceComponent[];
}

/** The SHA-256 of a Cargo.lock, the same with either line end. */
export function cargoLockHash(cratesDir: string): string {
  const lock = readFileSync(join(cratesDir, "Cargo.lock"), "utf8").replace(/\r\n/g, "\n");
  return createHash("sha256").update(lock).digest("hex");
}

export function cratesDirOf(appDir: string): string {
  return join(appDir, CRATES_DIR);
}

export function readRustCratesSnapshot(appDir: string): RustCratesSnapshot {
  return JSON.parse(readFileSync(join(appDir, RUST_CRATES_SNAPSHOT), "utf8")) as RustCratesSnapshot;
}

/** Writes the checked-in crate list from Cargo, for builds that cannot run it. */
export function writeRustCratesSnapshot(appDir: string): RustCratesSnapshot {
  const cratesDir = cratesDirOf(appDir);
  const snapshot = {
    cargoLock: cargoLockHash(cratesDir),
    crates: cargoCrateComponents(appDir),
  };
  writeFileSync(join(appDir, RUST_CRATES_SNAPSHOT), `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshot;
}

export interface RustCrates {
  readonly crates: readonly OpenSourceComponent[];
  /** Why the list is not up to date with Cargo, or undefined when it is. */
  readonly warning?: string;
}

const UPDATE_COMMAND = "pnpm --filter @openpaint/web licenses:rust";

const cache = new Map<string, RustCrates>();

/**
 * The crates linked into OpenPaint's WebAssembly kernels: from Cargo when it runs, else from the
 * checked-in list. Either way, a list that no longer matches comes with a warning.
 */
export function rustCrateComponents(appDir: string): RustCrates {
  const cached = cache.get(appDir);
  if (cached !== undefined) return cached;
  const cratesDir = cratesDirOf(appDir);
  const snapshot = readRustCratesSnapshot(appDir);
  let result: RustCrates;
  try {
    const crates = cargoCrateComponents(appDir);
    const current =
      snapshot.cargoLock === cargoLockHash(cratesDir) &&
      JSON.stringify(snapshot.crates) === JSON.stringify(crates);
    result = current
      ? { crates }
      : { crates, warning: `${RUST_CRATES_SNAPSHOT} is out of date; run ${UPDATE_COMMAND}.` };
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    const stale =
      !existsSync(join(cratesDir, "Cargo.lock")) || snapshot.cargoLock !== cargoLockHash(cratesDir);
    result = {
      crates: snapshot.crates,
      warning: `Cargo could not list the Rust crates (${reason}), so the checked-in ${RUST_CRATES_SNAPSHOT} is used${stale ? ", and it does not match Cargo.lock" : ""}.`,
    };
  }
  cache.set(appDir, result);
  return result;
}
