import { DecodeError } from "@openpaint/codecs";
import { OutOfMemoryError } from "@openpaint/document";
import { createTranslator, enUS } from "@openpaint/i18n";
import { describe, expect, it } from "vitest";
import {
  CodecUnavailableError,
  failureText,
  openFailure,
  saveFailure,
  UnrecognizedFileError,
} from "./file-errors";

const t = createTranslator("en-US", enUS);

function domError(name: string): DOMException {
  return new DOMException("failed", name);
}

describe("openFailure (FMT-OPEN-04)", () => {
  it.each([
    [new DecodeError("bad bytes"), "There was an error opening the file."],
    [domError("NotFoundError"), "The file could not be found."],
    [domError("NotReadableError"), "There was an error reading the file."],
    [domError("NotAllowedError"), "Access was denied to the requested file."],
    [new UnrecognizedFileError("a.xyz"), "The image type is not recognized, and cannot be opened."],
    [new Error("surprise"), "There was an error while opening the file."],
  ])("maps %# to its message", (error, text) => {
    expect(failureText(openFailure(error), t)).toBe(text);
  });

  it("reports memory as the load message", () => {
    const error = new OutOfMemoryError(10, 0, "newImage");
    expect(failureText(openFailure(error), t)).toBe("Not enough memory to load the image.");
  });

  it("names the codec and its error when the codec failed to load", () => {
    const error = new CodecUnavailableError(new Error("WASM missing"));
    expect(failureText(openFailure(error), t)).toBe(
      "Working with this file type requires a codec that could not be loaded: WASM missing",
    );
  });
});

describe("saveFailure (FMT-SAVE-05)", () => {
  it("maps write errors to the matching save message", () => {
    expect(failureText(saveFailure(domError("NotAllowedError"), "write"), t)).toBe(
      "Access is denied. Use File > Save As... to save under a different location or name.",
    );
    expect(failureText(saveFailure(domError("NotFoundError"), "write"), t)).toBe(
      "The file could not be found. Use File > Save As... to save to another location.",
    );
    expect(failureText(saveFailure(domError("QuotaExceededError"), "write"), t)).toBe(
      "There is not enough storage space to save the file.",
    );
    expect(failureText(saveFailure(domError("UnknownError"), "write"), t)).toBe(
      "An I/O error occurred when writing to the file.",
    );
  });

  it("reports an encoder failure as a generic save error", () => {
    expect(failureText(saveFailure(new Error("encoder"), "encode"), t)).toBe(
      "There was an error while saving the file.",
    );
  });

  it("reports memory as the save message in either phase", () => {
    const error = new OutOfMemoryError(10, 0, "newImage");
    expect(failureText(saveFailure(error, "encode"), t)).toBe(
      "Not enough memory to save the image.",
    );
  });
});
