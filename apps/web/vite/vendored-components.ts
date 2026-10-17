import { readFileSync } from "node:fs";
import { join } from "node:path";
import { copyrightOf, type OpenSourceComponent } from "./open-source-licenses.ts";

interface VendoredComponent {
  readonly name: string;
  readonly title: string;
  readonly version: string;
  readonly license: string;
  readonly url: string;
  /** The license file copied from the package, relative to the app directory. */
  readonly licenseFile: string;
}

/**
 * Third-party artwork copied into the app's source rather than installed as a dependency, so the
 * dependency walk cannot find it: the icon path data in src/icons/icon-set.ts. The license files
 * are the ones in each npm package at the listed version.
 */
const VENDORED: readonly VendoredComponent[] = [
  {
    name: "@phosphor-icons/core",
    title: "Phosphor Icons",
    version: "2.1.1",
    license: "MIT",
    url: "https://github.com/phosphor-icons/core",
    licenseFile: "src/icons/LICENSE-phosphor.txt",
  },
  {
    // Its license waives notices for icons used in an app (section 5), so the list leaves it out.
    name: "remixicon",
    title: "Remix Icon",
    version: "4.9.1",
    license: "Remix Icon License v1.0",
    url: "https://github.com/Remix-Design/RemixIcon",
    licenseFile: "src/icons/LICENSE-remixicon.txt",
  },
];

/** The vendored components with their full license texts. */
export function vendoredComponents(appDir: string): OpenSourceComponent[] {
  return VENDORED.map(({ licenseFile, ...component }) => {
    const licenseText = readFileSync(join(appDir, licenseFile), "utf8")
      .replace(/\r\n/g, "\n")
      .trimEnd();
    return { ...component, kind: "icons", copyright: copyrightOf(licenseText), licenseText };
  });
}
