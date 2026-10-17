import { describe, expect, it } from "vitest";
import { HOTKEY_CYCLE_WINDOW_MS, type HotkeyTool, resolveHotkey } from "./hotkeys";

/** The roster letters and flags of TL-ROSTER-01, in roster order. */
const ROSTER: readonly HotkeyTool[] = [
  { id: "rectangleSelect", hotkey: "S", skipIfActive: false },
  { id: "moveSelectedPixels", hotkey: "M", skipIfActive: false },
  { id: "lassoSelect", hotkey: "S", skipIfActive: false },
  { id: "moveSelection", hotkey: "M", skipIfActive: false },
  { id: "ellipseSelect", hotkey: "S", skipIfActive: false },
  { id: "zoom", hotkey: "Z", skipIfActive: false },
  { id: "magicWand", hotkey: "S", skipIfActive: false },
  { id: "pan", hotkey: "H", skipIfActive: false },
  { id: "paintBucket", hotkey: "F", skipIfActive: false },
  { id: "gradient", hotkey: "G", skipIfActive: false },
  { id: "paintbrush", hotkey: "B", skipIfActive: true },
  { id: "eraser", hotkey: "E", skipIfActive: true },
  { id: "pencil", hotkey: "P", skipIfActive: true },
  { id: "colorPicker", hotkey: "K", skipIfActive: true },
  { id: "cloneStamp", hotkey: "L", skipIfActive: false },
  { id: "recolor", hotkey: "R", skipIfActive: true },
  { id: "text", hotkey: "T", skipIfActive: false },
  { id: "lineCurve", hotkey: "O", skipIfActive: false },
  { id: "shapes", hotkey: "O", skipIfActive: false },
];

function press(
  letter: string,
  activeId: string,
  options: { reverse?: boolean; lastSwitchAt?: number; now?: number; pointerHeld?: boolean } = {},
) {
  return {
    letter,
    reverse: options.reverse ?? false,
    activeId,
    lastSwitchAt: options.lastSwitchAt,
    now: options.now ?? 10_000,
    pointerHeld: options.pointerHeld ?? false,
  };
}

describe("resolveHotkey", () => {
  it("selects the first tool with the letter from any other tool", () => {
    expect(resolveHotkey(ROSTER, press("s", "paintbrush"))).toEqual({
      consumed: true,
      toolId: "rectangleSelect",
    });
  });

  it("ignores keys that no tool uses", () => {
    expect(resolveHotkey(ROSTER, press("q", "paintbrush"))).toEqual({ consumed: false });
  });

  it("cycles through same-letter tools within the window, then wraps", () => {
    const lastSwitchAt = 10_000;
    const next = (activeId: string) =>
      resolveHotkey(ROSTER, press("S", activeId, { lastSwitchAt, now: lastSwitchAt + 500 })).toolId;
    expect(next("rectangleSelect")).toBe("lassoSelect");
    expect(next("lassoSelect")).toBe("ellipseSelect");
    expect(next("ellipseSelect")).toBe("magicWand");
    expect(next("magicWand")).toBe("rectangleSelect");
  });

  it("cycles O between Line / Curve and Shapes", () => {
    const lastSwitchAt = 0;
    const result = resolveHotkey(ROSTER, press("o", "lineCurve", { lastSwitchAt, now: 1 }));
    expect(result.toolId).toBe("shapes");
  });

  it("starts from the top again after the 2 s window", () => {
    const result = resolveHotkey(
      ROSTER,
      press("S", "rectangleSelect", {
        lastSwitchAt: 10_000,
        now: 10_000 + HOTKEY_CYCLE_WINDOW_MS + 1,
      }),
    );
    expect(result.toolId).toBe("rectangleSelect");
  });

  it("keeps the window edge inclusive", () => {
    const result = resolveHotkey(
      ROSTER,
      press("S", "rectangleSelect", {
        lastSwitchAt: 10_000,
        now: 10_000 + HOTKEY_CYCLE_WINDOW_MS,
      }),
    );
    expect(result.toolId).toBe("lassoSelect");
  });

  it("does not cycle when the active tool has another letter", () => {
    const result = resolveHotkey(
      ROSTER,
      press("S", "paintbrush", { lastSwitchAt: 10_000, now: 10_100 }),
    );
    expect(result.toolId).toBe("rectangleSelect");
  });

  it("reverses the order when Shift is held", () => {
    const result = resolveHotkey(
      ROSTER,
      press("S", "rectangleSelect", { reverse: true, lastSwitchAt: 0, now: 1 }),
    );
    expect(result.toolId).toBe("magicWand");
  });

  it("does nothing for a skip-if-active tool that is already active", () => {
    expect(resolveHotkey(ROSTER, press("B", "paintbrush"))).toEqual({ consumed: true });
    expect(resolveHotkey(ROSTER, press("e", "eraser"))).toEqual({ consumed: true });
  });

  it("switches to a non-skip tool that shares the letter with the active tool", () => {
    const result = resolveHotkey(ROSTER, press("M", "moveSelectedPixels"));
    expect(result.toolId).toBe("moveSelectedPixels");
  });

  it("consumes the key but does not switch while a pointer is held", () => {
    expect(resolveHotkey(ROSTER, press("B", "zoom", { pointerHeld: true }))).toEqual({
      consumed: true,
    });
  });
});
