import { describe, expect, it } from "vitest";
import {
  MIX_MODE_COUNT,
  MIX_MODE_KEYS,
  MIX_MODE_OVER,
  mixModeOptions,
  mixModeProperty,
} from "./index";

describe("render blend modes (FX-SHARED-MIXMODE)", () => {
  it("lists the 46 modes in the spec's order", () => {
    expect(MIX_MODE_COUNT).toBe(46);
    expect(new Set(MIX_MODE_KEYS).size).toBe(46);
    const labels = mixModeOptions().map((option) => option.label);
    expect(labels.slice(0, 4)).toEqual(["mix.over", "mix.under", "mix.overwrite", "mix.multiply"]);
    expect(labels[7]).toBe("mix.dissolve");
    expect(labels[28]).toBe("mix.division");
    expect(labels[29]).toBe("mix.additive");
    expect(labels[34]).toBe("mix.max");
    expect(labels[35]).toBe("mix.in");
    expect(labels[42]).toBe("mix.maskInvert");
    expect(labels[43]).toBe("mix.xor8");
    expect(labels[45]).toBe("mix.xorComposite");
  });

  it("values each option by its code, from 0 to 45", () => {
    const values = mixModeOptions().map((option) => option.value);
    expect(values).toEqual(Array.from({ length: 46 }, (_, code) => code));
  });

  it("builds the Blend Mode drop-down with Over as the default and a description caption", () => {
    const property = mixModeProperty();
    expect(property).toMatchObject({
      kind: "choice",
      key: "blendMode",
      label: "property.noCaption",
      defaultValue: MIX_MODE_OVER,
      control: { description: "property.blendMode" },
    });
    expect(property.options).toHaveLength(46);
    expect(mixModeProperty(3).defaultValue).toBe(3);
  });
});
