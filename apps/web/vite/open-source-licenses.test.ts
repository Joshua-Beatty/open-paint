// @vitest-environment node
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenSourceComponent as ClientComponent } from "../src/help/open-source";
import { BUNDLED_FONT_SPECS } from "../src/text/font-manifest";
import {
  bundledComponents,
  COMPONENTS_PLACEHOLDER,
  collectOpenSourceComponents,
  componentsOfModules,
  copyrightOf,
  formatThirdPartyNotices,
  licenseChoices,
  NOTICE_FREE_LICENSES,
  NOTICE_REQUIRED_LICENSES,
  noticeComponents,
  type OpenSourceComponent,
  openSourceLicenses,
  packageDirOf,
  requiresNotice,
  serviceWorkerComponents,
  shipsWasmKernels,
  unclassifiedLicenses,
} from "./open-source-licenses";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));

let root: string;

function writePackage(
  dir: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "opaint-licenses-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("collectOpenSourceComponents", () => {
  it("walks runtime dependencies below the app and lists each installed package once", () => {
    const app = join(root, "app");
    writePackage(app, {
      name: "app",
      dependencies: { a: "1.0.0" },
      devDependencies: { dev: "1.0.0" },
    });
    writePackage(
      join(app, "node_modules", "a"),
      {
        name: "a",
        version: "1.0.0",
        license: "MIT",
        repository: { type: "git", url: "git+https://example.test/a.git" },
        dependencies: { b: "2.0.0" },
      },
      { LICENSE: "MIT text for a\r\n" },
    );
    writePackage(
      join(app, "node_modules", "a", "node_modules", "b"),
      {
        name: "b",
        version: "2.0.0",
        licenses: [{ type: "ISC" }, { type: "MIT" }],
        repository: "owner/b",
        optionalDependencies: { missing: "1.0.0" },
      },
      { "LICENSE.md": "ISC text for b" },
    );
    writePackage(join(app, "node_modules", "dev"), {
      name: "dev",
      version: "1.0.0",
      license: "MIT",
    });

    expect(collectOpenSourceComponents(app)).toEqual([
      {
        name: "a",
        title: "a",
        kind: "library",
        version: "1.0.0",
        license: "MIT",
        url: "https://example.test/a",
        copyright: "",
        licenseText: "MIT text for a",
      },
      {
        name: "b",
        title: "b",
        kind: "library",
        version: "2.0.0",
        license: "ISC OR MIT",
        url: "https://github.com/owner/b",
        copyright: "",
        licenseText: "ISC text for b",
      },
    ]);
  });

  it("walks through a workspace package without listing it", () => {
    const app = join(root, "app");
    writePackage(app, { name: "app", dependencies: { "@scope/ws": "workspace:*" } });
    const workspace = join(root, "packages", "ws");
    writePackage(workspace, { name: "@scope/ws", version: "0.0.0", dependencies: { c: "1.0.0" } });
    writePackage(join(workspace, "node_modules", "c"), {
      name: "c",
      version: "1.0.0",
      license: "BSD-3-Clause",
    });
    mkdirSync(join(app, "node_modules", "@scope"), { recursive: true });
    // pnpm links workspace packages; a junction is the Windows-safe equivalent of that link.
    symlinkSync(workspace, join(app, "node_modules", "@scope", "ws"), "junction");
    const names = collectOpenSourceComponents(app).map((component) => component.name);
    expect(names).toEqual(["c"]);
  });

  it("uses the checked license text for a package that ships none, only at the checked version", () => {
    const app = join(root, "app");
    writePackage(app, {
      name: "app",
      dependencies: { "client-only": "0.0.1", dotignore: "0.1.2" },
    });
    writePackage(join(app, "node_modules", "client-only"), {
      name: "client-only",
      version: "0.0.1",
      license: "MIT",
    });
    writePackage(join(app, "node_modules", "dotignore"), {
      name: "dotignore",
      version: "0.1.2",
      license: "MIT",
    });
    const components = collectOpenSourceComponents(app);
    expect(components.find((component) => component.name === "client-only")?.licenseText).toMatch(
      /^MIT License\n\nCopyright \(c\) Meta Platforms/,
    );
    expect(components.find((component) => component.name === "dotignore")?.licenseText).toBe("");
  });

  it("fails the build when a required dependency is not installed", () => {
    const app = join(root, "app");
    writePackage(app, { name: "app", dependencies: { gone: "1.0.0" } });
    expect(() => collectOpenSourceComponents(app)).toThrow("Cannot find the dependency gone");
  });

  it("lists the real web app's runtime dependencies with a license for each", () => {
    const components = collectOpenSourceComponents(APP_DIR);
    const names = components.map((component) => component.name);
    expect(names).toContain("react");
    expect(names.some((name) => name.startsWith("@openpaint/"))).toBe(false);
    for (const component of components) {
      expect(component.license.length).toBeGreaterThan(0);
    }
  });

  it("gives the packages that ship no license file their license text", () => {
    const components = collectOpenSourceComponents(APP_DIR);
    for (const name of ["client-only", "clipper2-js"]) {
      const component = components.find((candidate) => candidate.name === name);
      expect(component?.licenseText.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("copyrightOf", () => {
  it("takes the notice lines, not the license's own words or templates", () => {
    const text = [
      "MIT License",
      "",
      "Copyright (c) 2020 Alice",
      "Copyright (c) 2020 Alice",
      "(c) 2021 Bob",
      "The above copyright notice and this permission notice shall be included",
      "Copyright notice, this list of conditions",
      "   Copyright [yyyy] [name of copyright owner]",
      "Copyright 2016 The Inter Project Authors",
    ].join("\n");
    expect(copyrightOf(text)).toBe(
      "Copyright (c) 2020 Alice\n(c) 2021 Bob\nCopyright 2016 The Inter Project Authors",
    );
    expect(copyrightOf("Apache License\nVersion 2.0, January 2004")).toBe("");
  });
});

describe("bundled fonts in the component list", () => {
  it("names a Fontsource package by its family, with the copyright from its metadata", () => {
    const app = join(root, "app");
    writePackage(app, { name: "app", dependencies: { "@fontsource/x": "1.0.0" } });
    writePackage(
      join(app, "node_modules", "@fontsource", "x"),
      { name: "@fontsource/x", version: "1.0.0", license: "Apache-2.0" },
      {
        LICENSE: "Apache License\nVersion 2.0, January 2004",
        "metadata.json": JSON.stringify({
          family: "Xenon",
          license: { attribution: "Copyright (c) 2010 by Xenon Type" },
        }),
      },
    );
    const [font] = collectOpenSourceComponents(app);
    expect(font).toMatchObject({
      name: "@fontsource/x",
      title: "Xenon",
      kind: "font",
      copyright: "Copyright (c) 2010 by Xenon Type",
    });
    // The bare Apache text has no notice, so the notices file adds it.
    const notices = formatThirdPartyNotices(font === undefined ? [] : [font]);
    expect(notices).toContain("Name: Xenon\n");
    expect(notices).toContain("Copyright: Copyright (c) 2010 by Xenon Type\n");
  });

  it("lists every bundled font family of the real app, each with a copyright and license text", () => {
    const components: readonly ClientComponent[] = bundledComponents(APP_DIR);
    const fonts = components.filter((component) => component.kind === "font");
    const families = fonts.map((component) => component.title);
    for (const spec of BUNDLED_FONT_SPECS) expect(families).toContain(spec.family);
    for (const font of fonts) {
      expect(font.copyright, font.name).toMatch(/Copyright/);
      expect(font.licenseText.length, font.name).toBeGreaterThan(1000);
    }
    // Remix Icon's license waives the notice for icons used in an app, so only Phosphor is listed.
    const icons = components.filter((component) => component.kind === "icons");
    expect(icons.map((component) => component.title)).toEqual(["Phosphor Icons"]);
    expect(icons.every((component) => component.copyright !== "")).toBe(true);
  });
});

describe("which licenses require a notice", () => {
  it("lists the licenses that require their notice with every copy", () => {
    expect([...NOTICE_REQUIRED_LICENSES].sort()).toEqual([
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
    expect([...NOTICE_FREE_LICENSES].sort()).toEqual([
      "0BSD",
      "CC0-1.0",
      "MIT-0",
      "Remix Icon License v1.0",
      "Unlicense",
      "WTFPL",
    ]);
    for (const id of NOTICE_REQUIRED_LICENSES) expect(requiresNotice(id), id).toBe(true);
    for (const id of NOTICE_FREE_LICENSES) expect(requiresNotice(id), id).toBe(false);
  });

  it("reads SPDX expressions, aliases and unknown names", () => {
    expect(requiresNotice("Boost Software License")).toBe(true);
    expect(requiresNotice("ISC OR MIT")).toBe(true);
    expect(requiresNotice("MIT OR CC0-1.0")).toBe(false);
    expect(requiresNotice("(Unlicense OR 0BSD)")).toBe(false);
    expect(requiresNotice("CC0-1.0 AND MIT")).toBe(true);
    expect(requiresNotice("Apache-2.0 WITH LLVM-exception")).toBe(true);
    expect(requiresNotice("Some Custom License")).toBe(true);
    expect(unclassifiedLicenses("MIT OR (Some Custom License AND 0BSD)")).toEqual([
      "Some Custom License",
    ]);
    expect(unclassifiedLicenses("Boost Software License")).toEqual([]);
  });

  it("parses nested choices and licenses that apply together", () => {
    expect(licenseChoices("(MIT OR Apache-2.0) AND IJG")).toEqual([
      ["MIT", "IJG"],
      ["Apache-2.0", "IJG"],
    ]);
    expect(licenseChoices("MIT/Apache-2.0")).toEqual([["MIT"], ["Apache-2.0"]]);
    expect(licenseChoices("BSD-3-Clause/MIT")).toEqual([["BSD-3-Clause"], ["MIT"]]);
    expect(licenseChoices("Apache-2.0 WITH LLVM-exception OR MIT")).toEqual([
      ["Apache-2.0"],
      ["MIT"],
    ]);
    expect(licenseChoices("Boost Software License")).toEqual([["BSL-1.0"]]);
    expect(licenseChoices("MIT OR")).toEqual([["MIT OR"]]);
    // Each choice still needs Zlib's notice, though MIT could be swapped for CC0.
    expect(requiresNotice("(MIT OR CC0-1.0) AND Zlib")).toBe(true);
    expect(requiresNotice("(CC0-1.0 OR MIT) AND Unlicense")).toBe(false);
    expect(requiresNotice("(MIT OR Apache-2.0) AND Unicode-3.0")).toBe(true);
    expect(requiresNotice("0BSD OR MIT OR Apache-2.0")).toBe(false);
  });

  it("drops the components whose license needs no notice, and lists each once", () => {
    const component = (name: string, license: string): OpenSourceComponent => ({
      name,
      title: name,
      kind: "library",
      version: "1.0.0",
      license,
      url: "",
      copyright: "",
      licenseText: "",
    });
    const listed = noticeComponents([
      component("tslib", "0BSD"),
      component("react", "MIT"),
      component("remixicon", "Remix Icon License v1.0"),
      component("dedicated", "CC0-1.0"),
      component("react", "MIT"),
      component("aria", "Apache-2.0"),
    ]);
    expect(listed.map((entry) => entry.name)).toEqual(["aria", "react"]);
  });

  it("classifies the license of every component the app could ship", () => {
    const components = [
      ...collectOpenSourceComponents(APP_DIR),
      ...serviceWorkerComponents(APP_DIR),
      ...bundledComponents(APP_DIR),
    ];
    for (const component of components) {
      expect(unclassifiedLicenses(component.license), component.name).toEqual([]);
    }
  });
});

describe("components of the built modules", () => {
  it("finds the package of a module id, including scoped, pnpm and query ids", () => {
    expect(packageDirOf("C:/app/node_modules/.pnpm/react@19/node_modules/react/index.js")).toBe(
      "C:/app/node_modules/.pnpm/react@19/node_modules/react",
    );
    expect(packageDirOf("C:\\app\\node_modules\\@scope\\pkg\\dist\\a.js?commonjs-proxy")).toBe(
      "C:/app/node_modules/@scope/pkg",
    );
    expect(packageDirOf("\0/app/node_modules/font/files/a.woff2?no-inline")).toBe(
      "/app/node_modules/font",
    );
    expect(packageDirOf("/app/packages/ui/src/index.ts")).toBeUndefined();
    expect(packageDirOf("\0virtual:open-source-licenses")).toBeUndefined();
  });

  it("lists only the packages the build's modules come from", () => {
    const app = join(root, "app");
    writePackage(app, { name: "app", dependencies: { used: "1.0.0", unused: "1.0.0" } });
    const used = join(app, "node_modules", "used");
    writePackage(used, { name: "used", version: "1.0.0", license: "MIT" }, { LICENSE: "MIT" });
    writePackage(join(app, "node_modules", "unused"), {
      name: "unused",
      version: "1.0.0",
      license: "MIT",
    });
    const ids = [join(used, "a.js"), join(used, "b.js"), join(app, "src", "main.ts")];
    expect(componentsOfModules(ids).map((component) => component.name)).toEqual(["used"]);
  });

  it("lists the shipped packages, the service worker's, the icons and upstream fonts, and no unused dependency", () => {
    const react = join(APP_DIR, "node_modules", "react", "index.js");
    // tslib is shipped by nothing but is installed; under 0BSD it needs no notice anyway.
    const store = join(APP_DIR, "..", "..", "node_modules", ".pnpm");
    const tslibStore = readdirSync(store).find((name) => name.startsWith("tslib@")) ?? "";
    const tslib = join(store, tslibStore, "node_modules", "tslib", "tslib.js");
    expect(componentsOfModules([tslib]).map((component) => component.license)).toEqual(["0BSD"]);
    const names = bundledComponents(APP_DIR, [react, tslib]).map((component) => component.name);
    expect(names).toEqual([
      "@phosphor-icons/core",
      "Lobster",
      "Lora",
      "Merriweather",
      "Playfair Display",
      "react",
      "workbox-cacheable-response",
      "workbox-core",
      "workbox-expiration",
      "workbox-precaching",
      "workbox-routing",
      "workbox-strategies",
    ]);
  });

  it("adds the Rust crates when the build loads the WebAssembly kernels, and the codec libraries of the loaded codecs", () => {
    const kernels = join(APP_DIR, "..", "..", "crates", "opaint-cpu", "pkg", "opaint_cpu.js");
    const webp = join(packageDir("@jsquash/webp"), "codec", "enc", "webp_enc.js");
    expect(shipsWasmKernels([kernels])).toBe(true);
    expect(shipsWasmKernels([webp])).toBe(false);
    const listed = bundledComponents(APP_DIR, [kernels, webp]);
    const kinds = (kind: string) =>
      listed.filter((component) => component.kind === kind).map((component) => component.name);
    expect(kinds("codec")).toEqual(["emscripten", "libwebp", "musl"]);
    expect(kinds("rust")).toContain("rust-std");
    expect(kinds("rust")).toContain("rav1e");
    expect(kinds("rust")).toContain("wasm-bindgen");
    // Crates that need no notice in either choice (adler2: 0BSD; memchr: Unlicense) are not listed.
    expect(kinds("rust")).not.toContain("adler2");
    expect(kinds("rust")).not.toContain("memchr");
    expect(bundledComponents(APP_DIR, [webp]).some((c) => c.kind === "rust")).toBe(false);
  });
});

/** An installed codec package, as the codecs workspace package that imports it sees it. */
function packageDir(name: string): string {
  return join(APP_DIR, "..", "..", "packages", "codecs", "node_modules", name);
}

describe("openSourceLicenses", () => {
  /** A plugin hook as a plain function, to call it outside a build. */
  const hook = (value: unknown) => value as (this: unknown, ...args: unknown[]) => unknown;
  const moduleContext = (ids: readonly string[]) => ({ getModuleIds: () => ids.values() });

  it("fills in the list once the app and worker builds have loaded their modules", () => {
    const { main, worker } = openSourceLicenses(APP_DIR);
    hook(main.configResolved).call(undefined, { command: "build" });
    expect(hook(main.load).call({}, "\0virtual:open-source-licenses")).toBe(
      `export default ${COMPONENTS_PLACEHOLDER};`,
    );
    const react = join(APP_DIR, "node_modules", "react", "index.js");
    hook(worker().buildEnd).call(moduleContext([react]));
    hook(main.buildEnd).call(moduleContext([join(APP_DIR, "src", "main.tsx")]));
    expect(hook(main.renderChunk).call({}, "var a=1;")).toBeNull();
    const rendered = hook(main.renderChunk).call({}, `var e=${COMPONENTS_PLACEHOLDER};`) as {
      code: string;
    };
    const list = JSON.parse(rendered.code.slice("var e=".length, -1)) as OpenSourceComponent[];
    const names = list.map((component) => component.name);
    expect(names).toContain("react");
    expect(names).toContain("workbox-core");
    expect(names).not.toContain("react-dom");
  });
});

describe("bundledComponents", () => {
  it("adds the icon set copied into the source, with its full license text", () => {
    const components = bundledComponents(APP_DIR);
    const phosphor = components.find((component) => component.name === "@phosphor-icons/core");
    expect(phosphor).toMatchObject({ version: "2.1.1", license: "MIT" });
    expect(phosphor?.licenseText).toMatch(/^MIT License\n\nCopyright \(c\) 2023 Phosphor Icons\n/);
    expect(phosphor?.licenseText).toContain(
      "The above copyright notice and this permission notice shall be included in all",
    );
    expect(components.some((component) => component.name === "remixicon")).toBe(false);
    const notices = formatThirdPartyNotices(components);
    expect(notices).toContain("@phosphor-icons/core 2.1.1 (MIT)");
    expect(notices).toContain("Copyright (c) 2023 Phosphor Icons");
  });

  it("puts the Rust crates and codec libraries in the notices, each with its license text", () => {
    const notices = formatThirdPartyNotices(bundledComponents(APP_DIR));
    expect(notices).toMatch(
      /^rav1e \S+ \(BSD-2-Clause\)\n=+\nProject: https:\/\/github\.com\/xiph\/rav1e/m,
    );
    expect(notices).toContain("Copyright (c) 2017-2023, the rav1e contributors");
    expect(notices).toMatch(
      /^libwebp \S+ \(BSD-3-Clause\)\n=+\nProject: https:\/\/github\.com\/webmproject\/libwebp\n/m,
    );
    expect(notices).toContain("Copyright (c) 2010, Google Inc. All rights reserved.");
    expect(notices).toMatch(/^Little-CMS \S+ \(MIT\)$/m);
    expect(notices).toContain("Copyright (c) 2023 Marti Maria Saguer");
    expect(notices).toMatch(/^jpeg-encoder \S+ \(\(MIT OR Apache-2\.0\) AND IJG\)$/m);
    expect(notices).toContain("Independent JPEG Group");
  });
});

describe("formatThirdPartyNotices", () => {
  const components: OpenSourceComponent[] = [
    {
      name: "alpha",
      title: "alpha",
      kind: "library",
      version: "1.2.3",
      license: "MIT",
      url: "https://example.test/alpha",
      copyright: "",
      licenseText: "MIT text for alpha",
    },
    {
      name: "beta",
      title: "beta",
      kind: "library",
      version: "0.1.0",
      license: "ISC",
      url: "",
      copyright: "",
      licenseText: "",
    },
  ];

  it("gives each component a heading with its license, project link and full text", () => {
    const notices = formatThirdPartyNotices(components);
    expect(notices.startsWith("OpenPaint third-party notices\n")).toBe(true);
    expect(notices).toContain("Components: 2");
    expect(notices).toContain(
      "alpha 1.2.3 (MIT)\n=================\nProject: https://example.test/alpha\n\nMIT text for alpha",
    );
    expect(notices.endsWith("\n")).toBe(true);
  });

  it("omits the project line when there is none and says when the license text is missing", () => {
    const section = formatThirdPartyNotices(components).split("beta 0.1.0 (ISC)")[1] ?? "";
    expect(section).not.toContain("Project:");
    expect(section).toContain("The license text for this package was not found.");
  });

  it("lists every component of the real build, each with a heading", () => {
    const components = collectOpenSourceComponents(APP_DIR);
    const notices = formatThirdPartyNotices(components);
    expect(notices).toContain(`Components: ${components.length}`);
    for (const component of components) {
      expect(notices).toContain(`${component.name} ${component.version} (${component.license})`);
    }
  });
});
