import {
  MAX_IMAGE_SIZE,
  MIN_IMAGE_SIZE,
  parseSelectionOutline,
  polygonsBounds,
  type Size,
} from "@openpaint/document";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_TYPE = "image/png";
const TEXT_TYPE = "text/plain";

/** The pixel size from a PNG's IHDR chunk, or undefined when the bytes are not a usable PNG. */
export function pngSize(bytes: Uint8Array): Size | undefined {
  if (bytes.length < 24) return undefined;
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return undefined;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!isUsable(width) || !isUsable(height)) return undefined;
  return { width, height };
}

function isUsable(dimension: number): boolean {
  return dimension >= MIN_IMAGE_SIZE && dimension <= MAX_IMAGE_SIZE;
}

/**
 * The size the New dialog starts from when the clipboard holds an image (its PNG size) or a
 * selection outline with area (its integer bounds), in that order (DOC-NEW-01 steps 1 and 2).
 * The system clipboard is read only when the browser already grants read access, so opening
 * the dialog never prompts for permission. Anything else gives undefined.
 */
export async function readClipboardNewSize(): Promise<Size | undefined> {
  if (!(await hasGrantedClipboardRead())) return undefined;
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (item.types.includes(PNG_TYPE)) {
        const bytes = new Uint8Array(await (await item.getType(PNG_TYPE)).arrayBuffer());
        const size = pngSize(bytes);
        if (size !== undefined) return size;
      }
    }
    for (const item of items) {
      if (!item.types.includes(TEXT_TYPE)) continue;
      const polygons = parseSelectionOutline(await (await item.getType(TEXT_TYPE)).text());
      if (polygons === undefined || polygons.length === 0) continue;
      const bounds = polygonsBounds(polygons);
      if (bounds.width > 0 && bounds.height > 0) {
        return { width: bounds.width, height: bounds.height };
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function hasGrantedClipboardRead(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({ name: "clipboard-read" as PermissionName });
    return status.state === "granted";
  } catch {
    return false;
  }
}
