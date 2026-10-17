/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findHardCodedStrings } from "./hard-coded-scan";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** The app shell and the shared components are where user-visible text must come from the catalog. */
const scanned = ["apps/web/src", "packages/ui/src"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => join(dir, name));
}

describe("user-visible text", () => {
  it("comes from the message catalog in apps/web and packages/ui (WEB-I18N-01)", () => {
    const files = scanned.flatMap((dir) => sourceFiles(join(root, dir)));
    expect(files.length).toBeGreaterThan(0);

    const findings = files.flatMap((file) =>
      findHardCodedStrings(readFileSync(file, "utf8"), file).map(
        (finding) => `${relative(root, file)}:${finding.line} ${JSON.stringify(finding.text)}`,
      ),
    );
    expect(findings).toEqual([]);
  });
});
