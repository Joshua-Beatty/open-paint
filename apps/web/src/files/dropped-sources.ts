import type { FileTypeDescriptor } from "@openpaint/extension-api";

/** What a drop carried: files from the desktop, or image addresses from another page (WEB-FILE-06). */
export interface DroppedSources {
  readonly files: readonly File[];
  readonly urls: readonly string[];
}

/** An image fetched from an address that was dragged from another page. */
export interface FetchedImage {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly contentType: string | null;
}

const DROP_TYPES: readonly string[] = ["Files", "text/uri-list", "text/html"];

/** True when a drag carries files or image addresses the app can open (UI-DOC-02). */
export function acceptsDrag(types: readonly string[]): boolean {
  return types.some((type) => DROP_TYPES.includes(type));
}

/**
 * Reads a drop. A `DataTransfer` can only be read during the event, so this runs as the drop
 * arrives. Folders are removed. Image addresses are read only when no file came with the drop.
 */
export function droppedSources(data: DataTransfer): DroppedSources {
  const files = filesOf(data);
  return { files, urls: files.length > 0 ? [] : urlsOf(data) };
}

function filesOf(data: DataTransfer): File[] {
  const items = Array.from(data.items);
  if (items.length === 0) return Array.from(data.files);
  return items.flatMap((item) => {
    if (item.kind !== "file") return [];
    if (item.webkitGetAsEntry()?.isDirectory === true) return [];
    const file = item.getAsFile();
    return file === null ? [] : [file];
  });
}

/** The address list of the drop, or the image sources of its HTML when there is no list. */
function urlsOf(data: DataTransfer): string[] {
  const list = data
    .getData("text/uri-list")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (list.length > 0) return unique(list);
  return imageSourcesOf(data.getData("text/html"));
}

/** The `src` of each `<img>` in a drop's HTML, resolved against the page that is running. */
export function imageSourcesOf(html: string): string[] {
  if (html === "") return [];
  const document = new DOMParser().parseFromString(html, "text/html");
  const sources = Array.from(
    document.querySelectorAll("img"),
    (img) => img.getAttribute("src") ?? "",
  );
  return unique(sources.filter((src) => src !== "").map((src) => resolveAddress(src)));
}

function resolveAddress(src: string): string {
  try {
    return new URL(src, globalThis.location?.href).href;
  } catch {
    return src;
  }
}

/**
 * Fetches an image dragged from another page. Only an address the page may read loads (WEB-FILE-06);
 * any other failure rejects, and the caller reports it.
 */
export async function fetchDroppedImage(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<FetchedImage> {
  const response = await fetcher(url, { mode: "cors" });
  if (!response.ok) throw new Error(`The image could not be fetched (${response.status}).`);
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get("content-type"),
  };
}

/**
 * The file name for a fetched image (FMT-OPEN-02 picks the type by extension). The name comes from
 * the address. When it has no known extension, the response's MIME type gives one.
 */
export function remoteFileName(
  url: string,
  contentType: string | null,
  types: readonly FileTypeDescriptor[],
): string {
  const base = baseNameOf(url) || "image";
  if (/\.[a-z0-9]{1,8}$/i.test(base)) return base;
  const mime = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  const type = types.find((candidate) => candidate.mimeTypes.includes(mime));
  return `${base}${type?.loadExtensions[0] ?? ""}`;
}

function baseNameOf(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").pop() ?? "";
    return decodeURIComponent(last);
  } catch {
    return "";
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
