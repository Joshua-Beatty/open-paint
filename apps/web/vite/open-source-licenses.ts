import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import type { Plugin } from "vite";
import { codecLibraryComponents } from "./codec-libraries.ts";
import { LICENSE_OVERRIDES } from "./license-overrides.ts";
import { rustCrateComponents } from "./rust-crates.ts";
import {
  installedRustc,
  readRustStdManifest,
  rustStdComponents,
  rustStdWarning,
} from "./rust-std.ts";
import { upstreamFontComponents } from "./upstream-fonts.ts";
import { vendoredComponents } from "./vendored-components.ts";

/** The module the About dialog loads the bundled component list from (SET-HELP-02). */
export const OPEN_SOURCE_MODULE_ID = "virtual:open-source-licenses";

const RESOLVED_ID = `\0${OPEN_SOURCE_MODULE_ID}`;

/** The license files of a package: LICENSE, LICENCE, COPYING or NOTICE, with an optional suffix. */
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([-.].*)?$/i;

/** Packages installed by a package manager sit under a `node_modules` segment. */
const INSTALLED_SEGMENT = `${sep}node_modules${sep}`;

/**
 * What a component is, which groups the license list: a font, an icon set, a JavaScript library,
 * a C or C++ library compiled into a codec's WebAssembly, or a Rust crate compiled into OpenPaint's.
 */
export type ComponentKind = "font" | "icons" | "library" | "codec" | "rust";

export interface OpenSourceComponent {
  /** The package name. */
  readonly name: string;
  /** The name to show: the font family or icon set, else the package name. */
  readonly title: string;
  readonly kind: ComponentKind;
  readonly version: string;
  readonly license: string;
  readonly url: string;
  /** The copyright lines of the component, or "" when it states none. */
  readonly copyright: string;
  readonly licenseText: string;
}

/**
 * A copyright line: "Copyright", "(c)" or "©" with a year or holder, but not the license's own
 * words about notices or holders, nor a template such as the Apache appendix's "[yyyy]".
 */
const COPYRIGHT_LINE =
  /^(?:Copyright\b(?!\s+(?:notice|holder|owner|and|law|license|statement)s?\b)|\(c\)\s|©\s?\d)/;
const COPYRIGHT_TEMPLATE = /\[yyyy\]|<year>|\{yyyy\}|\[name of copyright owner\]/i;

/** The copyright lines a license text starts its notice with (at most three, without repeats). */
export function copyrightOf(licenseText: string): string {
  const lines = licenseText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => COPYRIGHT_LINE.test(line) && !COPYRIGHT_TEMPLATE.test(line));
  return [...new Set(lines)].slice(0, 3).join("\n");
}

interface FontMetadata {
  readonly family?: string;
  readonly license?: { readonly attribution?: string };
}

/** A Fontsource package's family and copyright line, from the metadata it ships. */
function fontMetadataOf(dir: string): FontMetadata | undefined {
  const file = join(dir, "metadata.json");
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as FontMetadata;
}

interface Manifest {
  readonly name?: string;
  readonly version?: string;
  readonly license?: unknown;
  readonly licenses?: unknown;
  readonly repository?: unknown;
  readonly homepage?: unknown;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
}

/** A string field, or the string under `key` when the field is an object such as `{ type, url }`. */
function member(value: unknown, key: string): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && key in value) {
    const field = (value as Record<string, unknown>)[key];
    return typeof field === "string" ? field : undefined;
  }
  return undefined;
}

function licenseOf(manifest: Manifest): string {
  const single = member(manifest.license, "type");
  if (single !== undefined) return single;
  if (Array.isArray(manifest.licenses)) {
    const types = manifest.licenses
      .map((entry) => member(entry, "type"))
      .filter((type): type is string => type !== undefined);
    if (types.length > 0) return types.join(" OR ");
  }
  return "UNKNOWN";
}

/** The repository as a browsable https URL, so the About list can link to it. */
function projectUrlOf(manifest: Manifest): string {
  const raw = member(manifest.repository, "url") ?? member(manifest.homepage, "") ?? "";
  const url = raw
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^github:/, "https://github.com/")
    .replace(/\.git$/, "");
  // npm's shorthand for a GitHub repository is "owner/project".
  return /^[\w.-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url}` : url;
}

function licenseTextOf(dir: string): string {
  const file = readdirSync(dir)
    .sort()
    .find((name) => LICENSE_FILE.test(name));
  if (file === undefined) return "";
  return readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n").trimEnd();
}

/** Node's lookup: `node_modules/<name>` in the directory or one of its ancestors. */
function findPackage(from: string, name: string): string | undefined {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function compareComponents(a: OpenSourceComponent, b: OpenSourceComponent): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.version === b.version) return 0;
  return a.version < b.version ? -1 : 1;
}

/**
 * The licenses whose terms require their copyright notice or license text to go with every copy
 * that is passed on, so a component under one of them is listed. A minified script or a subset
 * font is still a copy (and for Zlib and BSL-1.0 not "machine-executable object code"), so their
 * conditions apply to the build. IJG asks a binary-only copy to credit the Independent JPEG Group
 * in its documentation; Unicode-3.0 asks for its notice with every copy of the data; NCSA asks a
 * binary copy to reproduce its notice in the documentation.
 */
export const NOTICE_REQUIRED_LICENSES: ReadonlySet<string> = new Set([
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSL-1.0",
  "CC-BY-4.0",
  "IJG",
  "ISC",
  "MIT",
  "MPL-2.0",
  "NCSA",
  "OFL-1.1",
  "Unicode-3.0",
  "Zlib",
]);

/**
 * The licenses that ask for no notice in a copy: public-domain dedications, the permissive licenses
 * without an attribution condition, and the Remix Icon License, which waives it for icons used in
 * an app (section 5). A component under one of them is left out of the list.
 */
export const NOTICE_FREE_LICENSES: ReadonlySet<string> = new Set([
  "0BSD",
  "CC0-1.0",
  "MIT-0",
  "Remix Icon License v1.0",
  "Unlicense",
  "WTFPL",
]);

/** Names packages give their license that are not SPDX identifiers. */
const LICENSE_ALIASES: Readonly<Record<string, string>> = {
  "Boost Software License": "BSL-1.0",
  "Apache 2.0": "Apache-2.0",
  "Apache License 2.0": "Apache-2.0",
};

/**
 * The ways an SPDX expression can be met: each inner list is one choice, and every license in it
 * applies at once. "(MIT OR Apache-2.0) AND IJG" gives [["MIT", "IJG"], ["Apache-2.0", "IJG"]].
 * The old Cargo form "MIT/Apache-2.0" is a choice; a WITH exception is dropped; names that are not
 * SPDX identifiers are mapped to theirs. An expression that does not parse is one license.
 */
export function licenseChoices(license: string): string[][] {
  const tokens = license
    .replaceAll("/", " OR ")
    .split(/(\(|\)|\s+(?:OR|AND|WITH)\s+)/i)
    .map((token) => token.trim())
    .filter((token) => token !== "");
  let at = 0;
  const peek = () => tokens[at]?.toUpperCase();
  const either = (): string[][] => {
    let choices = both();
    while (peek() === "OR") {
      at++;
      choices = [...choices, ...both()];
    }
    return choices;
  };
  const both = (): string[][] => {
    let choices = one();
    while (peek() === "AND") {
      at++;
      const next = one();
      choices = choices.flatMap((left) => next.map((right) => [...left, ...right]));
    }
    return choices;
  };
  const one = (): string[][] => {
    const token = tokens[at++];
    if (token === "(") {
      const inner = either();
      if (tokens[at++] !== ")") throw new Error("unbalanced");
      return inner;
    }
    if (token === undefined || token === ")" || /^(OR|AND|WITH)$/i.test(token)) {
      throw new Error("unexpected");
    }
    if (peek() === "WITH") at += 2;
    return [[LICENSE_ALIASES[token] ?? token]];
  };
  try {
    const choices = either();
    if (at === tokens.length) return choices;
  } catch {
    // Falls through to the whole text as one license.
  }
  const whole = license.trim();
  return [[LICENSE_ALIASES[whole] ?? whole]];
}

/**
 * Whether a license (an SPDX expression such as "MIT OR CC0-1.0") requires the component's notice
 * in the build. With a choice ("OR") the build takes the alternative that does not, if any; with
 * several licenses at once ("AND") each must be met. A license in neither list counts as requiring
 * a notice, so an unknown license is listed rather than dropped.
 */
export function requiresNotice(license: string): boolean {
  return licenseChoices(license).every((choice) =>
    choice.some((id) => !NOTICE_FREE_LICENSES.has(id)),
  );
}

/** The license identifiers of an expression that are in neither list, so need a decision. */
export function unclassifiedLicenses(license: string): string[] {
  const ids = new Set(licenseChoices(license).flat());
  return [...ids].filter(
    (id) => !NOTICE_REQUIRED_LICENSES.has(id) && !NOTICE_FREE_LICENSES.has(id),
  );
}

/** One installed package as a listed component. */
function componentOf(dir: string): OpenSourceComponent {
  const manifest = readManifest(dir);
  const name = manifest.name ?? basename(dir);
  const version = manifest.version ?? "";
  const override = LICENSE_OVERRIDES[name];
  const licenseText =
    licenseTextOf(dir) ||
    (override !== undefined && override.version === version ? override.licenseText : "");
  const font = name.startsWith("@fontsource") ? fontMetadataOf(dir) : undefined;
  return {
    name,
    title: font?.family ?? name,
    kind: font === undefined ? "library" : "font",
    version,
    license: licenseOf(manifest),
    url: projectUrlOf(manifest),
    // A font's license file may be the bare Apache text, so its copyright comes from the metadata.
    copyright: font?.license?.attribution?.trim() || copyrightOf(licenseText),
    licenseText,
  };
}

/**
 * The installed package a module of the build comes from: the folder under the last
 * `node_modules` segment of its path, or undefined for the app's own code and virtual modules.
 */
export function packageDirOf(moduleId: string): string | undefined {
  const path = (moduleId.replace(/^\0/, "").split("?")[0] ?? "").replaceAll("\\", "/");
  const marker = "/node_modules/";
  const index = path.lastIndexOf(marker);
  if (index < 0) return undefined;
  const segments = path.slice(index + marker.length).split("/");
  const length = segments[0]?.startsWith("@") ? 2 : 1;
  if (segments.length <= length) return undefined;
  return `${path.slice(0, index)}${marker}${segments.slice(0, length).join("/")}`;
}

/** The installed packages the modules of a build come from, each listed once. */
export function componentsOfModules(moduleIds: Iterable<string>): OpenSourceComponent[] {
  const dirs = new Set<string>();
  for (const id of moduleIds) {
    const dir = packageDirOf(id);
    if (dir !== undefined && existsSync(join(dir, "package.json"))) dirs.add(dir);
  }
  const found = new Map<string, OpenSourceComponent>();
  for (const dir of dirs) {
    const component = componentOf(dir);
    found.set(`${component.name}@${component.version}`, component);
  }
  return [...found.values()].sort(compareComponents);
}

/**
 * The packages the generated service worker is built from: the build writes it after the bundle,
 * from the Workbox modules its precaching, navigation route and font cache use.
 */
export const SERVICE_WORKER_PACKAGES = [
  "workbox-cacheable-response",
  "workbox-core",
  "workbox-expiration",
  "workbox-precaching",
  "workbox-routing",
  "workbox-strategies",
] as const;

/** The service worker's packages, as installed with the tool that builds it. */
export function serviceWorkerComponents(appDir: string): OpenSourceComponent[] {
  const builder = findPackage(appDir, "workbox-build");
  if (builder === undefined)
    throw new Error("Cannot find workbox-build, which builds the service worker.");
  return SERVICE_WORKER_PACKAGES.map((name) => {
    const dir = findPackage(builder, name);
    if (dir === undefined) throw new Error(`Cannot find ${name}, which the service worker uses.`);
    return componentOf(dir);
  });
}

/**
 * Every installed package that the app's runtime dependencies pull in, found by walking the
 * `dependencies` and `optionalDependencies` of `appDir` and of each package below it. Workspace
 * packages are walked through but not listed, since they are OpenPaint's own MIT code. The dev
 * server lists these, since it has no build to read the shipped modules from.
 */
export function collectOpenSourceComponents(appDir: string): OpenSourceComponent[] {
  const visited = new Set<string>();
  const found = new Map<string, OpenSourceComponent>();

  const record = (dir: string): void => {
    const component = componentOf(dir);
    found.set(`${component.name}@${component.version}`, component);
  };

  const visit = (dir: string): void => {
    if (visited.has(dir)) return;
    visited.add(dir);
    const manifest = readManifest(dir);
    const required = manifest.dependencies ?? {};
    const optional = manifest.optionalDependencies ?? {};
    for (const name of [...Object.keys(required), ...Object.keys(optional)]) {
      const packageDir = findPackage(dir, name);
      if (packageDir === undefined) {
        if (name in optional) continue;
        throw new Error(`Cannot find the dependency ${name} of ${manifest.name ?? dir}.`);
      }
      if (packageDir.includes(INSTALLED_SEGMENT)) record(packageDir);
      visit(packageDir);
    }
  };

  visit(appDir);
  return [...found.values()].sort(compareComponents);
}

/** The components to list: those whose license requires their notice, once each, by name. */
export function noticeComponents(
  components: readonly OpenSourceComponent[],
): OpenSourceComponent[] {
  const found = new Map<string, OpenSourceComponent>();
  for (const component of components) {
    if (requiresNotice(component.license))
      found.set(`${component.name}@${component.version}`, component);
  }
  return [...found.values()].sort(compareComponents);
}

/** Whether the build's modules include OpenPaint's WebAssembly kernels (crates/opaint-cpu). */
export function shipsWasmKernels(moduleIds: readonly string[]): boolean {
  return moduleIds.some((id) => id.replaceAll("\\", "/").includes("/opaint-cpu/pkg/"));
}

/**
 * What the build ships that needs a notice: the installed packages its modules (`moduleIds`, from
 * the app and its workers) come from, the service worker's packages, the artwork and the upstream
 * font files copied into the source, the C and C++ libraries in the codec WebAssembly it loads
 * (with the Emscripten runtime and musl libc they are built with), and the Rust crates and standard
 * library linked into its own WebAssembly kernels. Without the module list (the dev server), the
 * runtime dependency walk stands in and every codec library and crate is listed.
 */
export function bundledComponents(
  appDir: string,
  moduleIds?: Iterable<string>,
): OpenSourceComponent[] {
  const ids = moduleIds === undefined ? undefined : [...moduleIds];
  const packages =
    ids === undefined ? collectOpenSourceComponents(appDir) : componentsOfModules(ids);
  const crates =
    ids === undefined || shipsWasmKernels(ids)
      ? [...rustCrateComponents(appDir).crates, ...rustStdComponents(appDir)]
      : [];
  return noticeComponents([
    ...packages,
    ...serviceWorkerComponents(appDir),
    ...vendoredComponents(appDir),
    ...upstreamFontComponents(appDir),
    ...codecLibraryComponents(appDir, ids),
    ...crates,
  ]);
}

/** The notices file the build writes to the root of the output, next to the app shell. */
export const THIRD_PARTY_NOTICES_FILE = "THIRD-PARTY-NOTICES.txt";

const SECTION_SEPARATOR = `\n\n${"-".repeat(72)}\n\n`;

/** The plain-text notices: each component with its project link and its full license text. */
export function formatThirdPartyNotices(components: readonly OpenSourceComponent[]): string {
  const sections = components.map((component) => {
    const heading = `${component.name} ${component.version} (${component.license})`;
    const lines = [heading, "=".repeat(heading.length)];
    if (component.title !== component.name) lines.push(`Name: ${component.title}`);
    if (component.url !== "") lines.push(`Project: ${component.url}`);
    // A license text without the notice (such as the bare Apache 2.0 text) gets it here.
    if (component.copyright !== "" && !component.licenseText.includes(component.copyright)) {
      lines.push(`Copyright: ${component.copyright}`);
    }
    lines.push(
      "",
      component.licenseText === ""
        ? "The license text for this package was not found."
        : component.licenseText,
    );
    return lines.join("\n");
  });
  return [
    "OpenPaint third-party notices",
    "",
    "OpenPaint is released under the MIT License. This file lists the third-party components in this build whose licenses require their notice to accompany it, with the license text each one ships with.",
    "",
    `Components: ${components.length}`,
    "",
    sections.join(SECTION_SEPARATOR),
    "",
  ].join("\n");
}

/**
 * Stands for the component list in the virtual module of a build until every module is known:
 * a free global, so minifying keeps it as it is.
 */
export const COMPONENTS_PLACEHOLDER = "__OPENPAINT_OPEN_SOURCE_COMPONENTS__";

export interface OpenSourceLicensePlugins {
  /** The app build's plugin. */
  readonly main: Plugin;
  /** A plugin for each worker build, which reports the worker's modules to the app build's list. */
  readonly worker: () => Plugin;
}

/**
 * Lists the third-party components the build ships whose licenses require a notice as a virtual
 * module, so the About dialog and Settings can load them, and writes the same list as a notices
 * file into the build output (PRD-12). The list is made from the modules the app and worker
 * builds load, so it names only what is shipped; the virtual module holds a placeholder until
 * then. The dev server lists the runtime dependencies instead.
 */
export function openSourceLicenses(appDir: string): OpenSourceLicensePlugins {
  const moduleIds = new Set<string>();
  let building = false;
  let components: OpenSourceComponent[] | undefined;
  const listed = (): OpenSourceComponent[] => {
    components ??= bundledComponents(appDir, building ? moduleIds : undefined);
    return components;
  };
  const main: Plugin = {
    name: "openpaint-open-source-licenses",
    configResolved(config) {
      building = config.command === "build";
    },
    resolveId(id) {
      return id === OPEN_SOURCE_MODULE_ID ? RESOLVED_ID : undefined;
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined;
      return `export default ${building ? COMPONENTS_PLACEHOLDER : JSON.stringify(listed())};`;
    },
    buildEnd() {
      for (const id of this.getModuleIds()) moduleIds.add(id);
    },
    renderChunk(code) {
      if (!code.includes(COMPONENTS_PLACEHOLDER)) return null;
      return { code: code.replace(COMPONENTS_PLACEHOLDER, JSON.stringify(listed())), map: null };
    },
    generateBundle() {
      const list = listed();
      const crates = list.some((component) => component.kind === "rust")
        ? rustCrateComponents(appDir)
        : undefined;
      if (crates?.warning !== undefined) this.warn(crates.warning);
      const std =
        crates === undefined
          ? undefined
          : rustStdWarning(readRustStdManifest(appDir), installedRustc());
      if (std !== undefined) this.warn(std);
      for (const component of list) {
        const unknown = unclassifiedLicenses(component.license);
        if (unknown.length > 0) {
          this.warn(
            `${component.name} has a license that is not classified (${unknown.join(", ")}); it is listed. Add it to NOTICE_REQUIRED_LICENSES or NOTICE_FREE_LICENSES.`,
          );
        }
      }
      this.emitFile({
        type: "asset",
        fileName: THIRD_PARTY_NOTICES_FILE,
        source: formatThirdPartyNotices(list),
      });
    },
  };
  const worker = (): Plugin => ({
    name: "openpaint-open-source-licenses-worker",
    buildEnd() {
      for (const id of this.getModuleIds()) moduleIds.add(id);
    },
  });
  return { main, worker };
}
