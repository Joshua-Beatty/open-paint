import { DEFAULT_RESOLUTION, Surface } from "@openpaint/document";
import {
  type ByteSource,
  defaultSaveToken,
  type FileDocument,
  type FileTypeDescriptor,
} from "@openpaint/extension-api";
import type { PropertyValues } from "@openpaint/properties";

/** A surface whose color channels differ per pixel, with the alpha the callback gives. */
export function pattern(
  width: number,
  height: number,
  alpha: (x: number, y: number) => number,
): Surface {
  const surface = new Surface(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      surface.data[at] = (x * 37) % 256;
      surface.data[at + 1] = (y * 53) % 256;
      surface.data[at + 2] = ((x + y) * 11) % 256;
      surface.data[at + 3] = alpha(x, y);
    }
  }
  return surface;
}

/** A one-layer document around a surface, with the default resolution and no metadata. */
export function documentOf(surface: Surface, extra: Partial<FileDocument> = {}): FileDocument {
  return {
    width: surface.width,
    height: surface.height,
    resolution: DEFAULT_RESOLUTION,
    colorProfile: "srgb",
    metadata: { xmp: [], user: {} },
    layers: [{ name: "Background", visible: true, opacity: 255, blendMode: 0, surface }],
    ...extra,
  };
}

/** Saves through the type's codec, the way the save flow does, and returns the written bytes. */
export async function saveWith(
  type: FileTypeDescriptor,
  file: FileDocument,
  token: PropertyValues = defaultSaveToken(type),
): Promise<Uint8Array> {
  const codec = await type.loadCodec();
  const chunks: Uint8Array[] = [];
  await codec.save(
    file,
    {
      write: async (chunk) => {
        chunks.push(chunk);
      },
    },
    token,
    () => undefined,
  );
  const written = chunks[0];
  if (written === undefined) throw new Error("the codec wrote nothing");
  return written;
}

/** Opens bytes through the type's codec, the way the open flow does. */
export async function loadWith(type: FileTypeDescriptor, bytes: Uint8Array): Promise<FileDocument> {
  const codec = await type.loadCodec();
  const source: ByteSource = { byteLength: bytes.length, readAll: async () => bytes };
  return codec.load(source);
}

/** The straight RGBA bytes of the first layer. */
export function pixelsOf(file: FileDocument): number[] {
  return Array.from(file.layers[0]?.surface.data ?? []);
}

/** The composite of a color over white, as FMT-QNT-03 gives it. */
export function overWhite(color: number, alpha: number): number {
  return Math.floor((color * alpha + 255 * (255 - alpha) + 127) / 255);
}
