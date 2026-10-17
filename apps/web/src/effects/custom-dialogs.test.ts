import { builtinEffectBindings } from "@openpaint/effects";
import { describe, expect, it } from "vitest";
import { CUSTOM_DIALOGS } from "./custom-dialogs";

describe("custom dialog providers (EXT-V1-02, ADJ-MENU-02a)", () => {
  it("has a provider for every custom dialog token that a built-in effect names", () => {
    const tokens = builtinEffectBindings(2).flatMap((binding) =>
      binding.descriptor.customDialog === undefined ? [] : [binding.descriptor.customDialog],
    );
    expect(tokens).toEqual(["levels", "curves"]);
    for (const token of tokens) {
      expect(CUSTOM_DIALOGS.get(token)).toBeTypeOf("function");
    }
  });

  it("registers no provider for an effect without a custom dialog", () => {
    expect(CUSTOM_DIALOGS.has("posterize")).toBe(false);
  });
});
