// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  decodeMappings,
  functionNameAt,
  repoPath,
  SourceMap,
  type SourceMapJson,
  SourceMapResolver,
  sourceMappingUrl,
} from "./source-map.ts";

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function vlq(value: number): string {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = rest & 31;
    rest >>>= 5;
    if (rest > 0) digit |= 32;
    out += BASE64[digit];
  } while (rest > 0);
  return out;
}

/** Encodes absolute segments `[column, source, line, column, name?]` per generated line. */
function encode(lines: number[][][]): string {
  let source = 0;
  let line = 0;
  let column = 0;
  let name = 0;
  return lines
    .map((segments) => {
      let generated = 0;
      return segments
        .map((segment) => {
          const [gen, src, srcLine, srcCol, nameIndex] = segment as [
            number,
            number,
            number,
            number,
            number?,
          ];
          let text =
            vlq(gen - generated) + vlq(src - source) + vlq(srcLine - line) + vlq(srcCol - column);
          generated = gen;
          source = src;
          line = srcLine;
          column = srcCol;
          if (nameIndex !== undefined) {
            text += vlq(nameIndex - name);
            name = nameIndex;
          }
          return text;
        })
        .join(",");
    })
    .join(";");
}

const ORIGINAL = [
  "export function strokeTo(point) {",
  "  const measure = useCallback(() => {",
  "  useEffect(() => {",
  "  async #frame(time: number) {",
  "  return (id, values) => {",
].join("\n");

/** A one-line bundle: `function a(n){...}` mapped onto the lines of ORIGINAL. */
const MAP: SourceMapJson = {
  version: 3,
  sources: [
    "../../src/stroke.ts",
    "../../../../node_modules/.pnpm/react@19/node_modules/react/index.js",
  ],
  sourcesContent: [ORIGINAL, null],
  names: ["strokeTo"],
  mappings: encode([
    [
      [0, 0, 0, 0],
      [9, 0, 0, 16, 0],
      [40, 0, 1, 18],
      [80, 0, 2, 2],
      [120, 0, 3, 2],
      [160, 0, 4, 9],
      [200, 1, 10, 4],
    ],
  ]),
};

describe("decodeMappings and SourceMap", () => {
  it("decodes segments with relative fields", () => {
    expect(decodeMappings("AAAA,EAAE;;CACA").map((line) => line.map((s) => [...s]))).toEqual([
      [
        [0, 0, 0, 0, -1],
        [2, 0, 0, 2, -1],
      ],
      [],
      [[1, 0, 1, 2, -1]],
    ]);
  });

  it("finds the original position of a generated one, and the source line", () => {
    const map = new SourceMap(MAP);
    expect(map.lookup(0, 9)).toEqual({
      source: "../../src/stroke.ts",
      line: 0,
      column: 16,
      name: "strokeTo",
    });
    expect(map.lookup(0, 85)).toMatchObject({ line: 2, column: 2, name: undefined });
    expect(map.lookup(5, 0)).toBeUndefined();
    expect(map.sourceLine("../../src/stroke.ts", 3)).toBe("  async #frame(time: number) {");
  });
});

describe("functionNameAt", () => {
  it("names declarations, assignments, methods and callbacks", () => {
    expect(functionNameAt("export function strokeTo(point) {", 0)).toBe("strokeTo");
    expect(functionNameAt("export function strokeTo(point) {", 16)).toBe("strokeTo");
    expect(functionNameAt("  const measure = useCallback(() => {", 18)).toBe("measure");
    expect(functionNameAt("  const measure = useCallback(() => {", 30)).toBe("measure");
    expect(functionNameAt("  useEffect(() => {", 2)).toBe("useEffect callback");
    expect(functionNameAt("  useEffect(() => {", 12)).toBe("useEffect callback");
    expect(functionNameAt("  async #frame(time: number) {", 2)).toBe("#frame");
    expect(functionNameAt("  render() {", 2)).toBe("render");
    expect(functionNameAt("  onClick: (event) => {", 11)).toBe("onClick");
    expect(functionNameAt("  return (id, values) => {", 9)).toBeUndefined();
    expect(functionNameAt("  if (ready) {", 2)).toBeUndefined();
  });
});

describe("repoPath", () => {
  const root = "C:/repo";
  it("places a built bundle's sources under apps/web/dist", () => {
    expect(repoPath("../../src/App.tsx", "/assets/index-1.js", root)).toBe("apps/web/src/App.tsx");
    expect(repoPath("../../../../packages/engine/src/engine.ts", "/assets/worker-1.js", root)).toBe(
      "packages/engine/src/engine.ts",
    );
  });

  it("places dev modules under apps/web and absolute paths under the repository", () => {
    expect(repoPath("App.tsx", "/src/App.tsx", root)).toBe("apps/web/src/App.tsx");
    expect(
      repoPath(
        "C:\\repo\\packages\\tools\\src\\brush.ts",
        "/@fs/C:/repo/packages/tools/src/brush.ts",
        root,
      ),
    ).toBe("packages/tools/src/brush.ts");
    expect(repoPath("/@fs/C:/repo/packages/a.ts", "/x.js", root)).toBe("packages/a.ts");
    expect(
      repoPath("document-sync.ts", "/@fs/C:/repo/packages/engine/src/document-sync.ts?v=1", root),
    ).toBe("packages/engine/src/document-sync.ts");
    expect(repoPath("/src/App.tsx", "/src/App.tsx", root)).toBe("apps/web/src/App.tsx");
  });
});

describe("SourceMapResolver", () => {
  it("reads the sourceMappingURL comment", () => {
    expect(sourceMappingUrl("a()\n//# sourceMappingURL=index-1.js.map\n")).toBe("index-1.js.map");
    expect(sourceMappingUrl("a()")).toBeUndefined();
  });

  it("resolves frames through external and inline maps and falls back without one", async () => {
    const inline = Buffer.from(JSON.stringify(MAP)).toString("base64");
    const files: Record<string, string> = {
      "http://app/assets/index-1.js": "bundle\n//# sourceMappingURL=index-1.js.map",
      "http://app/assets/index-1.js.map": JSON.stringify(MAP),
      "http://app/src/inline.ts": `code\n//# sourceMappingURL=data:application/json;base64,${inline}`,
      "http://app/assets/plain.js": "no map here",
    };
    const fetched: string[] = [];
    const resolver = new SourceMapResolver(async (url) => {
      fetched.push(url);
      return files[url];
    }, "C:/repo");
    await resolver.load([
      "http://app/assets/index-1.js",
      "http://app/src/inline.ts",
      "http://app/assets/plain.js",
      "http://app/assets/cpu_bg.wasm",
      "chrome://resources/x.js",
    ]);
    expect(resolver.mapped).toBe(2);
    expect(fetched).not.toContain("http://app/assets/cpu_bg.wasm");
    const frame = (url: string, columnNumber: number, functionName = "a") => ({
      functionName,
      url,
      lineNumber: 0,
      columnNumber,
    });
    // Minified: the name comes from the source.
    expect(resolver.resolve(frame("http://app/assets/index-1.js", 9))).toEqual({
      name: "strokeTo",
      location: "apps/web/src/stroke.ts:1",
      origin: "app",
    });
    expect(resolver.resolve(frame("http://app/assets/index-1.js", 120))).toMatchObject({
      name: "#frame",
    });
    expect(resolver.resolve(frame("http://app/assets/index-1.js", 200))).toMatchObject({
      location: "react/index.js:11",
      origin: "lib",
    });
    // Dev modules keep their own names.
    expect(resolver.resolve(frame("http://app/src/inline.ts", 40, "measure"))).toMatchObject({
      name: "measure",
      origin: "app",
    });
    expect(resolver.resolve(frame("http://app/assets/plain.js", 3, "q"))).toEqual({
      name: "q",
      location: "/assets/plain.js:1:4",
      origin: "bundle",
    });
  });
});
