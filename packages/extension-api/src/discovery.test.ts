import type { MessageId } from "@openpaint/i18n";
import { definePropertySchema } from "@openpaint/properties";
import { describe, expect, it } from "vitest";
import {
  effectMenu,
  findOpenFileType,
  findSaveFileType,
  openAcceptExtensions,
  openFileTypes,
  saveFileTypes,
  shapeCategories,
} from "./discovery";
import type { EffectCategory, EffectDescriptor } from "./effects";
import type { FileTypeDescriptor, FileTypeHost } from "./file-types";
import { EffectRegistry, FileTypeRegistry, ShapeRegistry } from "./registry";
import type { ShapeDescriptor } from "./shapes";

const schema = definePropertySchema({ properties: [] });

function effect(
  id: string,
  label: MessageId,
  options: { submenu?: string; category?: EffectCategory; configurable?: boolean } = {},
): EffectDescriptor {
  return {
    id,
    apiVersion: 1,
    label,
    icon: `icon.${id}`,
    category: options.category ?? "effect",
    submenu: options.submenu,
    configurable: options.configurable ?? true,
    kind: "cpuRegion",
    schema,
  };
}

/** Display names for the catalog ids the fixtures use. */
const names: Partial<Record<MessageId, string>> = {
  "app.name": "Zed",
  "app.description": "Alpha",
  "property.radius": "Fixed",
  "property.gammaBoost": "Beta",
  "property.quality": "Loose A",
  "graphics.status.deviceLossFallback": "Loose B",
  "effect.gaussianBlur": "Level",
};

function resolveLabel(id: MessageId): string {
  return names[id] ?? id;
}

function fileType(id: string, options: { load?: string[]; save?: string[] }): FileTypeDescriptor {
  const load = options.load ?? [];
  const save = options.save ?? [];
  return {
    id,
    apiVersion: 1,
    label: "app.name",
    icon: `icon.${id}`,
    loadExtensions: load,
    saveExtensions: save,
    mimeTypes: [],
    capabilities: {
      supportsLayers: false,
      supportsCustomHeaders: false,
      supportsSaving: save.length > 0,
      supportsLoading: load.length > 0,
      savesWithProgress: false,
      supportsCancellation: false,
    },
    saveOptions: schema,
    loadCodec: () => Promise.reject(new Error("not used")),
    isLossless: () => true,
  };
}

describe("effectMenu", () => {
  const registry = new EffectRegistry();
  registry.register(effect("zed", "app.name", { submenu: "blurs" }));
  registry.register(effect("beta", "property.gammaBoost", { submenu: "artistic" }));
  registry.register(effect("alpha", "app.description", { submenu: "blurs" }));
  registry.register(effect("loose2", "graphics.status.deviceLossFallback"));
  registry.register(effect("loose1", "property.quality"));
  registry.register(effect("hidden", "effect.gaussianBlur", { category: "hidden" }));
  registry.register(effect("level", "effect.gaussianBlur", { category: "adjustment" }));
  registry.register(effect("fixed", "property.radius", { submenu: "blurs", configurable: false }));

  it("lists submenus alphabetically, with their items sorted by name", () => {
    const menu = effectMenu(registry, "effect", resolveLabel);
    expect(menu.submenus.map((submenu) => submenu.name)).toEqual(["artistic", "blurs"]);
    const blurs = menu.submenus[1];
    expect(blurs?.items.map((item) => item.id)).toEqual(["alpha", "fixed", "zed"]);
  });

  it("lists effects without a submenu after the submenus, sorted by name", () => {
    const menu = effectMenu(registry, "effect", resolveLabel);
    expect(menu.items.map((item) => item.id)).toEqual(["loose1", "loose2"]);
  });

  it("adds an ellipsis only to configurable effects (EXT-02-01)", () => {
    const blurs = effectMenu(registry, "effect", resolveLabel).submenus[1]?.items ?? [];
    expect(blurs.find((item) => item.id === "alpha")).toEqual({
      id: "alpha",
      title: "Alpha...",
      icon: "icon.alpha",
      configurable: true,
    });
    expect(blurs.find((item) => item.id === "fixed")).toMatchObject({
      title: "Fixed",
      configurable: false,
    });
  });

  it("never lists hidden effects and keeps adjustments in their own menu", () => {
    const ids = (category: "effect" | "adjustment") => {
      const menu = effectMenu(registry, category, resolveLabel);
      return [...menu.submenus.flatMap((submenu) => submenu.items), ...menu.items].map(
        (item) => item.id,
      );
    };
    expect(ids("effect")).not.toContain("hidden");
    expect(ids("effect")).not.toContain("level");
    expect(ids("adjustment")).toEqual(["level"]);
  });

  it("returns an empty menu for an empty registry", () => {
    expect(effectMenu(new EffectRegistry())).toEqual({ submenus: [], items: [] });
  });
});

describe("file type lists", () => {
  const registry = new FileTypeRegistry();
  const host = { services: {} } as FileTypeHost;
  registry.registerFactory(
    () => [
      fileType("png", { load: [".png"], save: [".png"] }),
      fileType("jpeg", { load: [".jpg", ".jpeg"], save: [".jpg"] }),
      fileType("dds", { load: [".dds"] }),
      fileType("jpg-loader", { load: [".jpg"] }),
    ],
    host,
  );

  it("offers save types only for types that save", () => {
    expect(saveFileTypes(registry).map((type) => type.id)).toEqual(["png", "jpeg"]);
  });

  it("offers open types in registration order, load-only types included", () => {
    expect(openFileTypes(registry).map((type) => type.id)).toEqual([
      "png",
      "jpeg",
      "dds",
      "jpg-loader",
    ]);
  });

  it("lists every loadable extension once for the All image types entry", () => {
    expect(openAcceptExtensions(registry)).toEqual([".png", ".jpg", ".jpeg", ".dds"]);
  });

  it("finds an open type by extension, case-insensitively, and the first claimant wins", () => {
    expect(findOpenFileType(registry, ".JPG")?.id).toBe("jpeg");
    expect(findOpenFileType(registry, ".dds")?.id).toBe("dds");
    expect(findOpenFileType(registry, ".gif")).toBeUndefined();
  });

  it("finds save types only among types that save", () => {
    expect(findSaveFileType(registry, ".png")?.id).toBe("png");
    expect(findSaveFileType(registry, ".dds")).toBeUndefined();
  });
});

describe("shapeCategories", () => {
  it("groups shapes by category in the order each category is first registered", () => {
    const registry = new ShapeRegistry();
    const shape = (id: string, category: string): ShapeDescriptor => ({
      id,
      apiVersion: 1,
      label: "app.name",
      category,
      geometry: { path: "M 0,0 Z", fillRule: "nonzero" },
      settings: schema,
    });
    registry.register(shape("rectangle", "basic"));
    registry.register(shape("line", "lines"));
    registry.register(shape("ellipse", "basic"));
    expect(
      shapeCategories(registry).map((group) => [group.category, group.shapes.map((s) => s.id)]),
    ).toEqual([
      ["basic", ["rectangle", "ellipse"]],
      ["lines", ["line"]],
    ]);
  });
});
