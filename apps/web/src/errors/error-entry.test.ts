import { t } from "@openpaint/i18n";
import { describe, expect, it } from "vitest";
import {
  describeError,
  errorDetailsText,
  formatLogEntry,
  LOG_ENTRY_SEPARATOR,
} from "./error-entry";

describe("describeError", () => {
  it("reads the name, message and stack of an Error", () => {
    const error = new TypeError("bad value");

    expect(describeError(error)).toEqual({ message: "TypeError: bad value", stack: error.stack });
  });

  it("uses the name alone when the Error has no message", () => {
    expect(describeError(new RangeError("")).message).toBe("RangeError");
  });

  it("reads a thrown string", () => {
    expect(describeError("plain text")).toEqual({ message: "plain text", stack: undefined });
  });

  it("names an empty thrown string as unknown", () => {
    expect(describeError("").message).toBe("Unknown error");
  });

  it("serializes a plain object", () => {
    expect(describeError({ code: 7 }).message).toBe('{"code":7}');
  });

  it("falls back to String() for values JSON cannot write", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(describeError(circular).message).toBe("[object Object]");
    expect(describeError(undefined).message).toBe("undefined");
  });
});

describe("errorDetailsText", () => {
  it("shows the stack, or the message when there is none", () => {
    expect(errorDetailsText({ message: "M", stack: "M\n    at f" })).toBe("M\n    at f");
    expect(errorDetailsText({ message: "M", stack: undefined })).toBe("M");
  });
});

describe("formatLogEntry (SET-ERR-01)", () => {
  const time = new Date("2026-10-13T12:00:00.000Z");

  it("writes the header, UTC time, version, message, stack, diagnostics and separator", () => {
    const entry = formatLogEntry({
      time,
      version: "1.2.3",
      details: { message: "TypeError: bad", stack: "TypeError: bad\n    at run" },
      diagnostics: "OpenPaint 1.2.3\n  Browser: Chrome 130",
      translate: t,
    });

    expect(entry.text.split("\n")).toEqual([
      t("error.log.header"),
      "",
      "Time (UTC): 2026-10-13T12:00:00.000Z",
      "Version: 1.2.3",
      "Message: TypeError: bad",
      "Stack:",
      "TypeError: bad",
      "    at run",
      "",
      "Diagnostics:",
      "OpenPaint 1.2.3",
      "  Browser: Chrome 130",
      "",
      LOG_ENTRY_SEPARATOR,
    ]);
  });

  it("uses the message as the list title, and its first line for a multi-line message", () => {
    const entry = formatLogEntry({
      time,
      version: "1.0.0",
      details: { message: "First line\nSecond line", stack: undefined },
      diagnostics: "",
      translate: t,
    });

    expect(entry.title).toBe("First line");
  });

  it("names the place the error was caught when the caller knows it", () => {
    const entry = formatLogEntry({
      time,
      version: "1.0.0",
      details: { message: "M", stack: undefined },
      context: "engine worker",
      diagnostics: "",
      translate: t,
    });

    expect(entry.text).toContain("Context: engine worker");
  });

  it("separates entries with a line of 60 dashes", () => {
    expect(LOG_ENTRY_SEPARATOR).toBe("-".repeat(60));
  });
});
