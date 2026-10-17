import { definePropertySchema } from "@openpaint/properties";
import { describe, expect, it } from "vitest";
import { dialogSettings } from "./dialog-settings";

describe("dialogSettings", () => {
  it("uses the defaults when no control sets a dialog option", () => {
    const schema = definePropertySchema({
      properties: [
        { kind: "double", key: "a", label: "property.radius", defaultValue: 1, min: 0, max: 2 },
      ],
    });
    expect(dialogSettings(schema)).toEqual({
      title: undefined,
      widthScale: 1,
      resizable: false,
      bottomSeparator: true,
      help: "none",
      helpContent: "",
    });
  });

  it("takes each option from the first control, in declaration order, that sets it", () => {
    const schema = definePropertySchema({
      properties: [
        {
          kind: "double",
          key: "a",
          label: "property.radius",
          defaultValue: 1,
          min: 0,
          max: 2,
          control: { dialogWidthScale: 1.5, dialogIsResizable: true, footnote: "property.quality" },
        },
        {
          kind: "int32",
          key: "b",
          label: "property.quality",
          defaultValue: 1,
          min: 0,
          max: 2,
          control: {
            dialogWidthScale: 3,
            dialogTitle: "property.gammaBoost",
            dialogShowBottomSeparator: false,
            dialogHelpContentType: "plainText",
            dialogHelpContent: "Help text",
          },
        },
      ],
    });
    expect(dialogSettings(schema)).toEqual({
      title: "property.gammaBoost",
      widthScale: 1.5,
      resizable: true,
      bottomSeparator: false,
      help: "plainText",
      helpContent: "Help text",
    });
  });

  it("shows catalog help as plain text", () => {
    const schema = definePropertySchema({
      properties: [
        {
          kind: "boolean",
          key: "a",
          label: "property.noCaption",
          defaultValue: false,
          control: { dialogHelpMessage: "property.alignObjectHelp" },
        },
      ],
    });
    expect(dialogSettings(schema)).toMatchObject({
      help: "plainText",
      helpMessage: "property.alignObjectHelp",
    });
  });
});
