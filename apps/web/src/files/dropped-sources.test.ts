import { EXTENSION_API_MAJOR, type FileTypeDescriptor } from "@openpaint/extension-api";
import { describe, expect, it, vi } from "vitest";
import {
  acceptsDrag,
  droppedSources,
  fetchDroppedImage,
  imageSourcesOf,
  remoteFileName,
} from "./dropped-sources";

/** A drop with the given items, files and data. Only the parts the reader uses are present. */
function dataTransfer(options: {
  readonly items?: readonly unknown[];
  readonly files?: readonly File[];
  readonly data?: Readonly<Record<string, string>>;
}): DataTransfer {
  return {
    items: options.items ?? [],
    files: options.files ?? [],
    getData: (type: string) => options.data?.[type] ?? "",
  } as unknown as DataTransfer;
}

function fileItem(file: File) {
  return {
    kind: "file",
    webkitGetAsEntry: () => ({ isDirectory: false }),
    getAsFile: () => file,
  };
}

function folderItem() {
  return {
    kind: "file",
    webkitGetAsEntry: () => ({ isDirectory: true }),
    getAsFile: () => null,
  };
}

const png: FileTypeDescriptor = {
  id: "png",
  apiVersion: EXTENSION_API_MAJOR,
  label: "fileType.png",
  icon: "file-png",
  loadExtensions: [".png"],
  saveExtensions: [".png"],
  mimeTypes: ["image/png"],
  capabilities: {
    supportsLayers: false,
    supportsCustomHeaders: false,
    supportsSaving: true,
    supportsLoading: true,
    savesWithProgress: false,
    supportsCancellation: false,
  },
  saveOptions: { properties: [] },
  loadCodec: async () => {
    throw new Error("not used");
  },
  isLossless: () => true,
};

describe("acceptsDrag (UI-DOC-02)", () => {
  it("accepts files, image addresses and HTML, and nothing else", () => {
    expect(acceptsDrag(["Files"])).toBe(true);
    expect(acceptsDrag(["text/uri-list"])).toBe(true);
    expect(acceptsDrag(["text/html", "text/plain"])).toBe(true);
    expect(acceptsDrag(["text/plain"])).toBe(false);
  });
});

describe("droppedSources (UI-DOC-02)", () => {
  it("returns the files and removes the folders", () => {
    const photo = new File(["x"], "photo.png");
    const sources = droppedSources(
      dataTransfer({ items: [folderItem(), fileItem(photo)], files: [photo] }),
    );

    expect(sources.files).toEqual([photo]);
    expect(sources.urls).toEqual([]);
  });

  it("returns nothing for a drop of folders alone", () => {
    const sources = droppedSources(dataTransfer({ items: [folderItem()] }));

    expect(sources.files).toEqual([]);
    expect(sources.urls).toEqual([]);
  });

  it("reads the address list of a drop from another page, skipping comments", () => {
    const sources = droppedSources(
      dataTransfer({
        data: {
          "text/uri-list": "# a comment\r\nhttps://a.test/one.png\r\n\r\nhttps://a.test/two.png",
        },
      }),
    );

    expect(sources.urls).toEqual(["https://a.test/one.png", "https://a.test/two.png"]);
  });

  it("reads the image sources of the HTML when there is no address list", () => {
    const sources = droppedSources(
      dataTransfer({ data: { "text/html": '<img src="https://a.test/cat.jpg">' } }),
    );

    expect(sources.urls).toEqual(["https://a.test/cat.jpg"]);
  });
});

describe("imageSourcesOf", () => {
  it("lists each image source once and resolves relative sources against the page", () => {
    const sources = imageSourcesOf(
      '<img src="https://a.test/x.png"><img src="https://a.test/x.png"><img src="pic.gif"><p>x</p>',
    );

    expect(sources).toHaveLength(2);
    expect(sources[0]).toBe("https://a.test/x.png");
    expect(sources[1]?.endsWith("/pic.gif")).toBe(true);
  });
});

describe("fetchDroppedImage (WEB-FILE-06)", () => {
  it("returns the bytes and the content type of the response", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    );

    const fetched = await fetchDroppedImage("https://a.test/x.png", fetcher);

    expect(Array.from(fetched.bytes)).toEqual([1, 2, 3]);
    expect(fetched.contentType).toBe("image/png");
    expect(fetcher).toHaveBeenCalledWith("https://a.test/x.png", { mode: "cors" });
  });

  it("rejects an address the server refuses", async () => {
    const fetcher = async () => new Response(null, { status: 403 });

    await expect(fetchDroppedImage("https://a.test/x.png", fetcher)).rejects.toThrow("403");
  });
});

describe("remoteFileName", () => {
  const types = [png];

  it("keeps the name of an address that already has an extension", () => {
    expect(remoteFileName("https://a.test/pics/cat.jpg", null, types)).toBe("cat.jpg");
  });

  it("adds the extension of the response's type when the address has none", () => {
    expect(remoteFileName("https://a.test/pics/cat", "image/png; charset=binary", types)).toBe(
      "cat.png",
    );
  });

  it("falls back to a generic name for an address with no name", () => {
    expect(remoteFileName("https://a.test/", null, types)).toBe("image");
  });
});
