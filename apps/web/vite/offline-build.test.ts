// @vitest-environment node
import { describe, expect, it } from "vitest";
import { externalReferences, missingHtmlAssets } from "./offline-build";

describe("externalReferences", () => {
  it("finds a script, stylesheet or image that loads from another origin", () => {
    const html = `<script type="module" src="https://cdn.example.test/app.js"></script>
<link rel="stylesheet" href="//cdn.example.test/app.css">
<img src="http://example.test/logo.png">`;
    expect(externalReferences("index.html", html)).toEqual([
      "https://cdn.example.test/app.js",
      "//cdn.example.test/app.css",
      "http://example.test/logo.png",
    ]);
  });

  it("accepts root-relative, relative, fragment, data and blob references", () => {
    const html = `<script src="/assets/index.js"></script>
<link href="./icon.svg"><a href="#top"></a><img src="data:image/png;base64,AAAA">
<img src="blob:https://example.test/abc">`;
    expect(externalReferences("index.html", html)).toEqual([]);
  });

  it("finds an external font or image in CSS, but not an inline data URL", () => {
    const css = `@font-face { src: url("https://fonts.example.test/a.woff2"); }
.a { background: url(data:image/svg+xml;base64,AAAA); }
.b { background: url(/assets/b.png); }
@import "https://fonts.example.test/base.css";`;
    expect(externalReferences("index.css", css)).toEqual([
      "https://fonts.example.test/a.woff2",
      "https://fonts.example.test/base.css",
    ]);
  });

  it("finds a dynamic import from another origin, but not a bundled chunk", () => {
    const js = `const a = import("https://cdn.example.test/codec.js");
const b = import("./chunk-abc.js");
const c = import(\`./wasm-\${name}.js\`);`;
    expect(externalReferences("assets/index.js", js)).toEqual([
      "https://cdn.example.test/codec.js",
    ]);
  });

  it("ignores URLs that are data, such as the license list and the SVG namespace", () => {
    const js = `var x = [{ url: "https://github.com/fontsource/font-files" }];
var ns = "http://www.w3.org/2000/svg";`;
    expect(externalReferences("assets/licenses.js", js)).toEqual([]);
  });

  it("does not scan other file types", () => {
    expect(externalReferences("icon.svg", `<svg xmlns="http://www.w3.org/2000/svg"/>`)).toEqual([]);
  });
});

describe("missingHtmlAssets", () => {
  it("lists root-relative references that the bundle does not contain", () => {
    const html = `<link rel="icon" href="/icon.svg"><script src="/assets/index.js"></script>
<link rel="manifest" href="/manifest.webmanifest"><link href="./relative.css">`;
    const bundled = new Set(["icon.svg", "assets/index.js"]);
    expect(missingHtmlAssets(html, bundled)).toEqual(["/manifest.webmanifest"]);
  });
});
