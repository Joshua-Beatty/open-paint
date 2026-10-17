import { surfaceToDataUrl } from "../tabs/thumbnail-url";
import type { Printer, PrintJob } from "./print-job";
import "./print.css";

/**
 * The print of WEB-PRN-01: the flattened image goes into a print-only view, which the print
 * stylesheet shows and nothing else. The view is removed once the print dialog closes.
 */
export const browserPrinter: Printer = {
  available: () => typeof window.print === "function",
  encode: surfaceToDataUrl,
  print: printView,
};

async function printView(job: PrintJob): Promise<void> {
  const view = document.createElement("div");
  view.className = job.layout.mode === "fit" ? "print-view is-fit" : "print-view";
  const image = document.createElement("img");
  image.alt = job.alt;
  image.src = job.src;
  image.style.width = job.layout.width;
  image.style.height = job.layout.height;
  view.append(image);
  document.body.append(view);
  window.addEventListener("afterprint", () => view.remove(), { once: true });
  try {
    await image.decode();
    window.print();
  } catch (cause) {
    view.remove();
    throw cause;
  }
}
