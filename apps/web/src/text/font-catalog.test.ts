// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  FontCatalog,
  type FontCatalogPorts,
  type FontFaceRegistration,
  familyOfFileName,
} from "./font-catalog";
import { fontSizePx, resolveFamily, textStyles, toggleTextStyle } from "./text-options";

const BYTES = new Uint8Array([1, 2, 3]);

function fakePorts(overrides: Partial<FontCatalogPorts> = {}) {
  const registered: FontFaceRegistration[] = [];
  const files = new Map<string, Uint8Array>([["Stored.otf", BYTES]]);
  const ports: FontCatalogPorts = {
    bundled: [
      { family: "Noto Sans", faces: [{ weight: 400, style: "normal", url: "/sans.woff2" }] },
      { family: "Pacifico", faces: [{ weight: 400, style: "normal", url: "/Pacifico.woff2" }] },
    ],
    register: vi.fn(async (face: FontFaceRegistration) => {
      registered.push(face);
    }),
    isLoaded: () => true,
    load: async () => 1,
    uploads: {
      list: async () => [...files.keys()],
      read: async (name) => files.get(name) ?? new Uint8Array(),
      write: async (name, bytes) => {
        files.set(name, bytes);
      },
    },
    listLocal: async () => ["Zapf", "Noto Sans", "Arial"],
    ...overrides,
  };
  return { ports, registered, files };
}

describe("FontCatalog (WEB-FONT-01)", () => {
  it("lists the bundled families and registers their faces, then the stored uploads", async () => {
    const { ports, registered } = fakePorts();
    const catalog = new FontCatalog(ports);
    expect(catalog.state.families.map((entry) => entry.family)).toEqual(["Noto Sans", "Pacifico"]);
    expect(catalog.state.local).toBe("idle");
    await catalog.start();
    expect(registered.map((face) => face.family)).toEqual(["Noto Sans", "Pacifico", "Stored"]);
    expect(catalog.state.families.map((entry) => [entry.family, entry.source])).toEqual([
      ["Noto Sans", "bundled"],
      ["Pacifico", "bundled"],
      ["Stored", "uploaded"],
    ]);
  });

  it("starts once, and a face that fails to register is skipped", async () => {
    const { ports } = fakePorts({
      register: vi.fn(async (face: FontFaceRegistration) => {
        if (face.family === "Pacifico") throw new Error("corrupt");
      }),
    });
    const catalog = new FontCatalog(ports);
    await catalog.start();
    await catalog.start();
    expect(ports.register).toHaveBeenCalledTimes(3);
    expect(catalog.state.families.map((entry) => entry.family)).toContain("Pacifico");
  });

  it("stores an uploaded font and lists it under its file name", async () => {
    const { ports, files } = fakePorts();
    const catalog = new FontCatalog(ports);
    await catalog.start();
    const family = await catalog.addUpload("My Font.ttf", BYTES);
    expect(family).toBe("My Font");
    expect(files.has("My Font.ttf")).toBe(true);
    expect(catalog.resolve("My Font")).toBe("My Font");
  });

  it("refuses an upload with no name", async () => {
    const catalog = new FontCatalog(fakePorts().ports);
    await expect(catalog.addUpload("", BYTES)).rejects.toThrow("no name");
  });

  it("lists the installed families in the one list by name, without repeats", async () => {
    const { ports } = fakePorts();
    const catalog = new FontCatalog(ports);
    const listener = vi.fn();
    catalog.subscribe(listener);
    await catalog.loadLocal();
    expect(catalog.state.local).toBe("ready");
    expect(catalog.state.families.map((entry) => [entry.family, entry.source])).toEqual([
      ["Arial", "local"],
      ["Noto Sans", "bundled"],
      ["Pacifico", "bundled"],
      ["Zapf", "local"],
    ]);
    expect(listener).toHaveBeenCalled();
  });

  it("sorts every family by name, ignoring case, with no groups (owner request)", async () => {
    const face = { weight: 400, style: "normal", url: "/f.woff2" } as const;
    const { ports } = fakePorts({
      bundled: ["Special Elite", "anton", "Noto Sans", "EB Garamond", "Bebas Neue"].map(
        (family) => ({ family, faces: [face] }),
      ),
      listLocal: async () => ["Zapf", "courier"],
    });
    const catalog = new FontCatalog(ports);
    expect(catalog.state.families.map((entry) => entry.family)).toEqual([
      "anton",
      "Bebas Neue",
      "EB Garamond",
      "Noto Sans",
      "Special Elite",
    ]);
    await catalog.start();
    await catalog.loadLocal();
    await catalog.addUpload("brush.ttf", BYTES);
    expect(catalog.state.families.map((entry) => entry.family)).toEqual([
      "anton",
      "Bebas Neue",
      "brush",
      "courier",
      "EB Garamond",
      "Noto Sans",
      "Special Elite",
      "Stored",
      "Zapf",
    ]);
  });

  it("reports a permission refusal as denied, and other failures as unavailable", async () => {
    const denied = new FontCatalog(
      fakePorts({
        listLocal: async () => {
          throw new DOMException("no", "NotAllowedError");
        },
      }).ports,
    );
    await denied.loadLocal();
    expect(denied.state.local).toBe("denied");

    const failed = new FontCatalog(
      fakePorts({
        listLocal: async () => {
          throw new Error("broken");
        },
      }).ports,
    );
    await failed.loadLocal();
    expect(failed.state.local).toBe("unavailable");
  });

  it("without the installed-fonts API, the state is unavailable and loading does nothing", async () => {
    const { listLocal: _omitted, ...ports } = fakePorts().ports;
    const catalog = new FontCatalog(ports);
    expect(catalog.state.local).toBe("unavailable");
    await catalog.loadLocal();
    expect(catalog.state.local).toBe("unavailable");
  });

  it("registers each bundled face with its characters", async () => {
    const { ports, registered } = fakePorts({
      bundled: [
        {
          family: "Inter",
          faces: [
            { weight: [100, 900], style: "normal", url: "/inter.woff2", unicodeRange: "U+0-FF" },
          ],
        },
      ],
    });
    const catalog = new FontCatalog(ports);
    expect(catalog.state.families[0]).toEqual({ family: "Inter", source: "bundled" });
    await catalog.start();
    expect(registered[0]).toEqual({
      family: "Inter",
      weight: [100, 900],
      style: "normal",
      data: "/inter.woff2",
      unicodeRange: "U+0-FF",
    });
  });

  it("loads a face that is not in yet once, and tells the listeners when it is (lazy loading)", async () => {
    let loaded = false;
    const load = vi.fn(async () => {
      await Promise.resolve();
      loaded = true;
      return 1;
    });
    const catalog = new FontCatalog(fakePorts({ isLoaded: () => loaded, load }).ports);
    const listener = vi.fn();
    catalog.subscribe(listener);
    const face = { family: "Pacifico", bold: true, italic: true };
    expect(catalog.ensure(face, "Hi")).toBe(false);
    expect(catalog.ensure(face, "iH")).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('italic bold 16px "Pacifico"', "Hi");
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    expect(catalog.ensure(face, "Hi")).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not retry or redraw for a face that fails to load", async () => {
    const load = vi.fn(async () => {
      throw new Error("offline");
    });
    const catalog = new FontCatalog(fakePorts({ isLoaded: () => false, load }).ports);
    const listener = vi.fn();
    catalog.subscribe(listener);
    const face = { family: "Pacifico", bold: false, italic: false };
    catalog.ensure(face);
    await Promise.resolve();
    catalog.ensure(face);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('16px "Pacifico"', " ");
    expect(listener).not.toHaveBeenCalled();
  });

  it("resolves a stored family, and falls back to the bundled sans family", () => {
    const catalog = new FontCatalog(fakePorts().ports);
    expect(catalog.resolve("Pacifico")).toBe("Pacifico");
    expect(catalog.resolve("Missing")).toBe("Noto Sans");
    expect(catalog.resolve(undefined)).toBe("Noto Sans");
  });
});

describe("familyOfFileName", () => {
  it("drops the folder and the extension", () => {
    expect(familyOfFileName("C:\\fonts\\Name.woff2")).toBe("Name");
    expect(familyOfFileName("noext")).toBe("noext");
    expect(familyOfFileName("dir/Other Font.otf")).toBe("Other Font");
  });
});

describe("text style and size helpers (TL-OPT-TEXT)", () => {
  it("reads the styles that are on, ignoring case and unknown names", () => {
    expect([...textStyles("Bold,italic")]).toEqual(["Bold", "Italic"]);
    expect([...textStyles("Regular")]).toEqual([]);
    expect([...textStyles(undefined)]).toEqual([]);
    expect([...textStyles("Strikeout, Nonsense")]).toEqual(["Strikeout"]);
  });

  it("toggles a style and keeps a fixed order, with Regular for none", () => {
    expect(toggleTextStyle("Regular", "Underline")).toBe("Underline");
    expect(toggleTextStyle("Italic", "Bold")).toBe("Bold,Italic");
    expect(toggleTextStyle("Bold,Italic", "Bold")).toBe("Italic");
    expect(toggleTextStyle("Underline", "Underline")).toBe("Regular");
  });

  it("converts points with the image DPI, or with a fixed 96 DPI", () => {
    expect(fontSizePx(12, "Points", 300)).toBe(50);
    expect(fontSizePx(12, "Fixed96Dpi", 300)).toBe(16);
  });

  it("resolves a family against the list, with the fallback when it is missing", () => {
    expect(resolveFamily("Pacifico", ["Noto Sans", "Pacifico"], "Noto Sans")).toBe("Pacifico");
    expect(resolveFamily("Gone", ["Pacifico", "Noto Sans"], "Noto Sans")).toBe("Noto Sans");
    expect(resolveFamily("Gone", ["Pacifico"], "Noto Sans")).toBe("Pacifico");
  });
});
