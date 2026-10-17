import { describe, expect, it } from "vitest";
import { History, type HistoryCommand } from "./history";

function command(name: string): HistoryCommand {
  return {
    name,
    undo: async () => {},
    redo: async () => {},
    release: () => {},
  };
}

describe("History restore (WEB-MEM-05)", () => {
  it("reports the saved position as a depth and an item index", () => {
    const history = new History();
    const a = command("A");
    const b = command("B");
    history.record(a);
    history.record(b);
    history.markSaved();
    expect(history.savedLocation).toEqual({ depth: 2, index: 1 });

    history.record(command("C"));
    expect(history.isSaved).toBe(false);
    expect(history.savedLocation).toEqual({ depth: 2, index: 1 });
  });

  it("reports a saved item that was discarded as dirty", async () => {
    const history = new History();
    history.record(command("A"));
    history.markSaved();
    await history.undo();
    history.record(command("B"));
    expect(history.savedLocation).toEqual({ depth: -1, index: -1 });
    expect(history.isSaved).toBe(false);
  });

  it("rebuilds both stacks and the saved position", async () => {
    const source = new History();
    const a = command("A");
    const b = command("B");
    source.record(a);
    source.record(b);
    await source.undo();
    const saved = source.savedLocation;

    const restored = new History();
    restored.restore(source.appliedCommands, source.undoneCommands, saved);
    expect(restored.entries).toEqual(source.entries);
    expect(restored.isSaved).toBe(source.isSaved);
    expect(restored.canRedo).toBe(true);
    expect(restored.redoName).toBe("B");
  });

  it("restores a clean position as clean, and undoing from it dirties the history", async () => {
    const history = new History("Base");
    history.record(command("A"));
    history.markSaved();
    const restored = new History();
    restored.restore(history.appliedCommands, history.undoneCommands, history.savedLocation);
    expect(restored.isSaved).toBe(true);
    expect(await restored.undo()).toBe(true);
    expect(restored.isSaved).toBe(false);
  });
});
