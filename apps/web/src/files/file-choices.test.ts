import { builtinFileTypeRegistry } from "@openpaint/codecs";
import { type FileTypeDescriptor, openFileTypes, saveFileTypes } from "@openpaint/extension-api";
import { createTranslator, enUS } from "@openpaint/i18n";
import { describe, expect, it } from "vitest";
import {
  extensionOf,
  nameForType,
  openPickerTypes,
  resolveDownloadName,
  savePickerTypes,
  suggestedName,
  typeForName,
  typeOfName,
} from "./file-choices";

describe("nameForType and typeForName (owner request: the name and the Type list agree)", () => {
  const types = [
    { id: "png", extensions: [".png"] },
    { id: "opaint", extensions: [".opaint"] },
    { id: "jpeg", extensions: [".jpg", ".jpeg"] },
  ] as const;
  const [pngType, opaint, jpegType] = types;

  it("swaps a savable extension for the chosen type's default one", () => {
    expect(nameForType("Untitled.png", types, opaint)).toBe("Untitled.opaint");
    expect(nameForType("photo.final.PNG", types, jpegType)).toBe("photo.final.jpg");
  });

  it("keeps a name that already ends in one of the type's extensions", () => {
    expect(nameForType("Untitled.jpeg", types, jpegType)).toBe("Untitled.jpeg");
  });

  it("leaves a name without a savable extension alone, since saving adds it", () => {
    expect(nameForType("sketch", types, opaint)).toBe("sketch");
    expect(nameForType("notes.v2", types, pngType)).toBe("notes.v2");
  });

  it("finds the type a typed extension belongs to, or none", () => {
    expect(typeForName("a.jpeg", types)?.id).toBe("jpeg");
    expect(typeForName("a.OPAINT", types)?.id).toBe("opaint");
    expect(typeForName("a.txt", types)).toBeUndefined();
    expect(typeForName("a", types)).toBeUndefined();
  });
});

const t = createTranslator("en-US", enUS);

function png(): FileTypeDescriptor {
  const type = openFileTypes(builtinFileTypeRegistry())[0];
  if (type === undefined) throw new Error("PNG is not registered.");
  return type;
}

/** A second type that saves JPEG files, to test the type a name picks. */
function jpeg(): FileTypeDescriptor {
  return {
    ...png(),
    id: "jpeg",
    label: "fileType.png",
    loadExtensions: [".jpg", ".jpeg"],
    saveExtensions: [".jpg", ".jpeg"],
    mimeTypes: ["image/jpeg"],
  };
}

describe("extensionOf", () => {
  it("returns the lower-case extension with its dot", () => {
    expect(extensionOf("Photo.PNG")).toBe(".png");
    expect(extensionOf("archive.tar.gz")).toBe(".gz");
  });

  it("returns nothing for a name without an extension", () => {
    expect(extensionOf("Untitled")).toBe("");
    expect(extensionOf(".png")).toBe("");
    expect(extensionOf("notes.a long name")).toBe("");
  });
});

describe("openPickerTypes (FMT-OPEN-01)", () => {
  it("lists all image types, then each type, then All Files", () => {
    const types = openPickerTypes([png(), jpeg()], t);
    expect(types.map((type) => type.description)).toEqual([
      "All image types",
      "PNG",
      "PNG",
      "All Files",
    ]);
    expect(types[0]?.extensions).toEqual([".png", ".jpg", ".jpeg"]);
    expect(types[0]?.mimeTypes).toEqual(["image/png", "image/jpeg"]);
  });

  it("still offers All Files when no type can load", () => {
    expect(openPickerTypes([], t).map((type) => type.description)).toEqual([
      "All image types",
      "All Files",
    ]);
  });
});

describe("savePickerTypes", () => {
  it("lists the savable types in the order given", () => {
    const types = savePickerTypes([jpeg(), png()], t);
    expect(types.map((type) => type.extensions)).toEqual([[".jpg", ".jpeg"], [".png"]]);
  });
});

describe("suggestedName (FMT-SAVE-01)", () => {
  it("swaps the extension for the type's default save extension", () => {
    expect(suggestedName("photo.jpg", png())).toBe("photo.png");
    expect(suggestedName("Untitled", png())).toBe("Untitled.png");
  });
});

describe("typeOfName and resolveDownloadName (FMT-SAVE-01)", () => {
  it("uses the type that owns the name's extension", () => {
    const types = [png(), jpeg()];
    const resolved = resolveDownloadName("shot.jpeg", types, png());
    expect(resolved.name).toBe("shot.jpeg");
    expect(resolved.type.id).toBe("jpeg");
    expect(typeOfName("shot.jpeg", types, png()).id).toBe("jpeg");
  });

  it("applies the selected type's extension when the name owns none", () => {
    expect(resolveDownloadName("sketch", [png()], png()).name).toBe("sketch.png");
    expect(resolveDownloadName("photo.bmp", [png()], png()).name).toBe("photo.bmp.png");
  });

  it("keeps the name when it already has the selected type's extension", () => {
    const resolved = resolveDownloadName("a.png", saveFileTypes(builtinFileTypeRegistry()), png());
    expect(resolved.name).toBe("a.png");
    expect(resolved.type.id).toBe("png");
  });
});
