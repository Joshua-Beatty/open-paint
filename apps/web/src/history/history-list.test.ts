import { t } from "@openpaint/i18n";
import { describe, expect, it } from "vitest";
import { currentStep, historyIconFor, historyIcons } from "./history-list";

describe("history icons", () => {
  const icons = historyIcons(t);

  it("gives each family of steps its icon (UI-FTW-04)", () => {
    expect(historyIconFor("New Image", icons)).toBe("document");
    expect(historyIconFor("Paste into New Image", icons)).toBe("document");
    expect(historyIconFor("New Layer", icons)).toBe("layer");
    expect(historyIconFor("Move Layer to Top", icons)).toBe("layer");
    expect(historyIconFor("Flip Horizontal (all)", icons)).toBe("image");
    expect(historyIconFor("Crop to Selection", icons)).toBe("image");
    expect(historyIconFor("Select All", icons)).toBe("selection");
    expect(historyIconFor("Fill Selection", icons)).toBe("pixels");
  });

  it("uses the layer icon for the named Layer steps", () => {
    expect(historyIconFor(t("history.layer", { name: "Background" }), icons)).toBe("layer");
  });

  it("falls back to the generic icon for names it does not know", () => {
    expect(historyIconFor("Mystery Tool", icons)).toBe("generic");
  });

  it("matches the shape steps by their name with the shape filled in", () => {
    expect(historyIconFor(t("history.drawShape", { shape: "Ellipse" }), icons)).toBe("pixels");
    expect(historyIconFor(t("history.changeToShape", { shape: "Heart" }), icons)).toBe("pixels");
    expect(historyIconFor(t("history.finishShape", { shape: "Star" }), icons)).toBe("pixels");
  });
});

describe("currentStep", () => {
  it("is the last applied step, or -1 when everything is undone", () => {
    const applied = (name: string, value: boolean) => ({ name, applied: value });
    expect(
      currentStep([applied("New Image", true), applied("New Layer", true), applied("Cut", false)]),
    ).toBe(1);
    expect(currentStep([applied("New Image", false)])).toBe(-1);
    expect(currentStep([])).toBe(-1);
  });
});
