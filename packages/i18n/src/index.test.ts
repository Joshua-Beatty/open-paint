import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import { createTranslator, enUS, t } from "./index";

describe("@openpaint/i18n", () => {
  it("returns English messages by id", () => {
    expect(t("app.name")).toBe("OpenPaint");
  });

  it("fills named ICU arguments", () => {
    expect(t("history.layer", { name: "Opacity" })).toBe("Layer Opacity");
  });

  it("keeps apostrophes and quotes in plain messages literal", () => {
    expect(t("clipboard.noImage")).toBe("The clipboard doesn't contain an image.");
    expect(t("history.pasteSelectionXor")).toBe('Paste Selection: Invert ("xor")');
  });

  it("selects plural forms for the locale", () => {
    const translate = createTranslator("en-US", {
      ...enUS,
      "app.name": "{count, plural, one {# layer} other {# layers}}",
    });
    expect(translate("app.name", { count: 1 })).toBe("1 layer");
    expect(translate("app.name", { count: 2 })).toBe("2 layers");
  });

  it("rejects ids that are not in the catalog at compile time", () => {
    // @ts-expect-error "not.a.message" is not a MessageId
    expect(() => t("not.a.message")).toThrow();
  });

  it("parses every English message as ICU MessageFormat", () => {
    for (const message of Object.values(enUS)) {
      expect(() => new IntlMessageFormat(message, "en-US")).not.toThrow();
    }
  });

  it("uses dotted camel-case ids and plain message text", () => {
    for (const [id, message] of Object.entries(enUS)) {
      expect(id, id).toMatch(/^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z0-9]*)+$/);
      expect(message, id).toBe(message.trim());
      expect(message, id).not.toMatch(/\{\d+\}/);
    }
  });
});
