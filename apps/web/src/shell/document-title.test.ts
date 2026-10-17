import { t } from "@openpaint/i18n";
import { describe, expect, it } from "vitest";
import { documentTitle, fileDisplayName } from "./document-title";

describe("fileDisplayName (UI-WIN-03)", () => {
  it("drops any directory part", () => {
    expect(fileDisplayName("photo.png")).toBe("photo.png");
    expect(fileDisplayName("C:\\Users\\me\\photo.png")).toBe("photo.png");
    expect(fileDisplayName("/home/josh/art/photo.png")).toBe("photo.png");
  });
});

describe("documentTitle (UI-WIN-03)", () => {
  it("is the app name alone with no image open", () => {
    expect(documentTitle(null, t)).toBe("OpenPaint");
  });

  it("shows the file name for a saved image", () => {
    expect(documentTitle({ path: "C:\\art\\photo.png", dirty: false }, t)).toBe(
      "photo.png - OpenPaint",
    );
  });

  it("uses Untitled for an image that was never saved", () => {
    expect(documentTitle({ dirty: false }, t)).toBe("Untitled - OpenPaint");
  });

  it("prefixes the whole title with * while the image has unsaved changes", () => {
    expect(documentTitle({ path: "photo.png", dirty: true }, t)).toBe("*photo.png - OpenPaint");
    expect(documentTitle({ dirty: true }, t)).toBe("*Untitled - OpenPaint");
  });
});
