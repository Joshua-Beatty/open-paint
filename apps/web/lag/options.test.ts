// @vitest-environment node
import { describe, expect, it } from "vitest";
import { appUrl, defaultSessionFolder, parseOptions, sessionFolderName, USAGE } from "./options.ts";

describe("parseOptions", () => {
  it("defaults to a production build, engine v1 and the default folder", () => {
    expect(parseOptions([])).toEqual({
      dev: false,
      engine: "v1",
      url: undefined,
      out: undefined,
      analyze: undefined,
      auto: false,
      help: false,
    });
  });

  it("reads every option, with values separate or after =", () => {
    expect(parseOptions(["--", "--dev", "--engine", "v2", "--out=rec", "--auto"])).toMatchObject({
      dev: true,
      engine: "v2",
      out: "rec",
      auto: true,
    });
    expect(parseOptions(["--url", "http://localhost:5173"]).url).toBe("http://localhost:5173/");
    expect(parseOptions(["--analyze", ".perf/lag/x"]).analyze).toBe(".perf/lag/x");
  });

  it("rejects unknown options, bad values and --dev with --url", () => {
    expect(() => parseOptions(["--fast"])).toThrow('Unknown option "--fast"');
    expect(() => parseOptions(["--engine", "v3"])).toThrow("v1 or v2");
    expect(() => parseOptions(["--out"])).toThrow("needs a value");
    expect(() => parseOptions(["--url", "not a url"])).toThrow();
    expect(() => parseOptions(["--dev", "--url", "http://x"])).toThrow("cannot be combined");
  });
});

describe("appUrl and sessionFolderName", () => {
  it("turns the perf instrumentation on", () => {
    expect(appUrl("http://127.0.0.1:4000/", "v2", false)).toBe(
      "http://127.0.0.1:4000/?perf=1&engine=v2",
    );
    expect(appUrl("http://127.0.0.1:4000/app/x", "v1", true)).toBe(
      "http://127.0.0.1:4000/?perf=1&bench=1&engine=v1",
    );
  });

  it("names a session folder by its UTC time, without colons", () => {
    expect(sessionFolderName(new Date("2026-10-14T20:15:03.456Z"))).toBe("2026-10-14T20-15-03Z");
  });

  it("records into the gitignored .perf/lag folder by default", () => {
    expect(defaultSessionFolder(new Date("2026-10-14T20:15:03.456Z"))).toBe(
      ".perf/lag/2026-10-14T20-15-03Z",
    );
    expect(USAGE).toContain("default .perf/lag/<timestamp>/");
  });
});
