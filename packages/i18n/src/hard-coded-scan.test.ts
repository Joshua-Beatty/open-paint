import { describe, expect, it } from "vitest";
import { findHardCodedStrings } from "./hard-coded-scan";

const texts = (source: string, fileName = "sample.tsx") =>
  findHardCodedStrings(source, fileName).map((finding) => finding.text);

describe("findHardCodedStrings", () => {
  it("flags JSX text", () => {
    expect(texts("const a = <p>Save changes</p>;")).toEqual(["Save changes"]);
  });

  it("passes catalog lookups and punctuation-only text", () => {
    expect(texts(`const a = <p>{t("app.name")} 1, 2</p>;`)).toEqual([]);
  });

  it("flags user-visible attributes but not other attributes", () => {
    const source = `const a = <button aria-label="Close" className="flex" title={"Undo"} id="x" />;`;
    expect(texts(source)).toEqual(["Close", "Undo"]);
  });

  it("flags string children and display properties", () => {
    const source = `const items = [{ label: "Fill", id: "fill" }]; const b = <b>{"Bold"}</b>;`;
    expect(texts(source)).toEqual(["Fill", "Bold"]);
  });

  it("reports the line of each finding", () => {
    expect(findHardCodedStrings("\n\n<p>Hi</p>", "a.tsx")[0]?.line).toBe(3);
  });

  it("parses TypeScript without JSX in .ts files", () => {
    expect(texts("const f = <T,>(x: T) => x; const s = 'Hello';", "a.ts")).toEqual([]);
  });
});
