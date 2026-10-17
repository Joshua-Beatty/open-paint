import { PALETTE_EXTENSION } from "./palette";
import type { PaletteFile } from "./palette-library";

/** Whether a file is a palette file by its extension (DOC-COL-03). */
export function isPaletteFile(file: { readonly name: string }): boolean {
  return file.name.toLowerCase().endsWith(PALETTE_EXTENSION);
}

function readFileText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file, "utf-8");
  });
}

/** The palette files of a list, read as text. Other files are skipped. */
export async function readPaletteFiles(files: Iterable<File>): Promise<PaletteFile[]> {
  const palettes: PaletteFile[] = [];
  for (const file of files) {
    if (isPaletteFile(file)) palettes.push({ fileName: file.name, text: await readFileText(file) });
  }
  return palettes;
}

/** Opens the file picker for palette files and resolves with the chosen files. */
export function pickPaletteFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = `${PALETTE_EXTENSION},text/plain`;
    input.multiple = true;
    input.addEventListener("change", () => resolve(Array.from(input.files ?? [])), { once: true });
    input.click();
  });
}

/** Saves text as a file through a download link (WEB-FILE-02). */
export function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
