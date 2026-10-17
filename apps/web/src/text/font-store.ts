import { openOpfsDirectory, readOpfsFile, writeOpfsFile } from "@openpaint/storage";
import { BUNDLED_FAMILIES } from "./bundled-fonts";
import {
  FontCatalog,
  type FontCatalogPorts,
  type FontFaceRegistration,
  type FontUploadStore,
} from "./font-catalog";

/** The OPFS folder that keeps the uploaded fonts (WEB-FONT-01, SET-STO-04). */
const FONT_FOLDER = "fonts";

/** The part of the directory handle that lists names. Typed here, as the DOM lib omits the iterator. */
interface NamedDirectory {
  keys(): AsyncIterable<string>;
}

/** The uploaded fonts, as files in the OPFS `fonts` folder. */
function opfsFontStore(): FontUploadStore {
  return {
    async list() {
      const directory = await openOpfsDirectory(FONT_FOLDER);
      const names: string[] = [];
      for await (const name of (directory as unknown as NamedDirectory).keys()) names.push(name);
      return names;
    },
    async read(name) {
      return readOpfsFile(await openOpfsDirectory(FONT_FOLDER), name);
    },
    async write(name, bytes) {
      await writeOpfsFile(await openOpfsDirectory(FONT_FOLDER), name, bytes);
    },
  };
}

/**
 * Makes one face available to the canvas and the page through the document's font set. A face
 * from a URL is fetched by the browser when it is first used; an uploaded file loads at once, so
 * a broken file is reported when it is added.
 */
async function registerInDocument(face: FontFaceRegistration): Promise<void> {
  const fromUrl = typeof face.data === "string";
  const source = typeof face.data === "string" ? `url("${face.data}")` : face.data.slice();
  const weight = typeof face.weight === "number" ? String(face.weight) : face.weight.join(" ");
  const font = new FontFace(face.family, source, {
    weight,
    style: face.style,
    ...(face.unicodeRange === undefined ? {} : { unicodeRange: face.unicodeRange }),
  });
  document.fonts.add(font);
  if (!fromUrl) await font.load();
}

/** Loads the faces of the document's font set that draw `text` in `font`. */
async function loadInDocument(font: string, text: string): Promise<number> {
  const faces = await document.fonts.load(font, text);
  return faces.filter((face) => face.status === "loaded").length;
}

/** The installed families, where the browser has the Local Font Access API (WEB-FONT-01). */
function browserListLocal(): (() => Promise<readonly string[]>) | undefined {
  const query = (globalThis as { queryLocalFonts?: () => Promise<readonly { family: string }[]> })
    .queryLocalFonts;
  if (query === undefined) return undefined;
  return async () => {
    const fonts = await query.call(globalThis);
    return [...new Set(fonts.map((font) => font.family))];
  };
}

/** The ports of the app: bundled fonts, OPFS uploads, the document's font set and installed fonts. */
export function browserFontPorts(): FontCatalogPorts {
  return {
    bundled: BUNDLED_FAMILIES,
    register: registerInDocument,
    isLoaded: (font, text) => document.fonts.check(font, text),
    load: loadInDocument,
    uploads: opfsFontStore(),
    listLocal: browserListLocal(),
  };
}

/** The font catalog of the app. Its loading starts with `fontCatalog.start()`. */
export const fontCatalog = new FontCatalog(browserFontPorts());
