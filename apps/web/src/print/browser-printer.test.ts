import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserPrinter } from "./browser-printer";
import type { PrintJob } from "./print-job";

const job: PrintJob = {
  src: "data:image/png;base64,PRINT",
  alt: "sketch.png",
  layout: { mode: "fit", width: "100%", height: "100%" },
};

describe("browserPrinter (WEB-PRN-01)", () => {
  const originalPrint = window.print;
  const originalDecode = HTMLImageElement.prototype.decode;

  beforeEach(() => {
    window.print = vi.fn();
    HTMLImageElement.prototype.decode = vi.fn(async () => undefined);
  });

  afterEach(() => {
    window.print = originalPrint;
    HTMLImageElement.prototype.decode = originalDecode;
    document.body.innerHTML = "";
  });

  it("is available where window.print exists", () => {
    expect(browserPrinter.available()).toBe(true);
  });

  it("shows the flattened image in a print-only view and opens the print dialog", async () => {
    await browserPrinter.print(job);

    const view = document.querySelector(".print-view");
    expect(view?.className).toBe("print-view is-fit");
    const image = view?.querySelector("img");
    expect(image?.src).toBe(job.src);
    expect(image?.alt).toBe("sketch.png");
    expect(image?.style.width).toBe("100%");
    expect(window.print).toHaveBeenCalledTimes(1);
  });

  it("removes the view when the print dialog closes", async () => {
    await browserPrinter.print(job);

    window.dispatchEvent(new Event("afterprint"));

    expect(document.querySelector(".print-view")).toBeNull();
  });

  it("removes the view and does not print when the image cannot be decoded", async () => {
    HTMLImageElement.prototype.decode = vi.fn(async () => {
      throw new Error("decode failed");
    });

    await expect(browserPrinter.print(job)).rejects.toThrow("decode failed");

    expect(document.querySelector(".print-view")).toBeNull();
    expect(window.print).not.toHaveBeenCalled();
  });
});
