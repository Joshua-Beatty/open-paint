import { describe, expect, it } from "vitest";
import { compoundCommand, History, type HistoryCommand } from "./history";

interface Log {
  readonly events: string[];
}

function command(name: string, log: Log, options: { failUndo?: boolean } = {}): HistoryCommand {
  return {
    name,
    undo: async () => {
      if (options.failUndo) throw new Error("undo failed");
      log.events.push(`undo ${name}`);
    },
    redo: async () => {
      log.events.push(`redo ${name}`);
    },
    release: () => {
      log.events.push(`release ${name}`);
    },
  };
}

describe("History step groups and compound items (DOC-HIS-01)", () => {
  it("records a group as one entry that undoes in reverse and redoes in order", async () => {
    const log: Log = { events: [] };
    const history = new History();
    history.group("Group", () => {
      history.record(command("A", log));
      history.record(command("B", log));
    });

    expect(history.entries).toEqual([{ name: "Group", applied: true }]);
    expect(history.undoName).toBe("Group");
    expect(await history.undo()).toBe(true);
    expect(log.events).toEqual(["undo B", "undo A"]);
    expect(await history.redo()).toBe(true);
    expect(log.events.slice(2)).toEqual(["redo A", "redo B"]);
  });

  it("records nothing when the action adds no item, and returns its result", () => {
    const history = new History();
    expect(history.group("Empty", () => 7)).toBe(7);
    expect(history.entries).toEqual([]);
  });

  it("clears the redo stack only when the group is recorded", async () => {
    const log: Log = { events: [] };
    const history = new History();
    history.record(command("A", log));
    history.record(command("B", log));
    await history.undo();

    history.group("G", () => {
      history.record(command("C", log));
    });

    expect(history.canRedo).toBe(false);
    expect(log.events).toEqual(["undo B", "release B"]);
    expect(history.entries).toEqual([
      { name: "A", applied: true },
      { name: "G", applied: true },
    ]);
  });

  it("keeps the items of an action that throws, so history matches the document", () => {
    const log: Log = { events: [] };
    const history = new History();
    expect(() =>
      history.group("Partial", () => {
        history.record(command("A", log));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(history.entries).toEqual([{ name: "Partial", applied: true }]);
  });

  it("nests a group inside its parent as one part", async () => {
    const log: Log = { events: [] };
    const history = new History();
    history.group("Outer", () => {
      history.record(command("A", log));
      history.group("Inner", () => {
        history.record(command("B", log));
      });
      history.record(command("C", log));
    });

    expect(history.entries).toEqual([{ name: "Outer", applied: true }]);
    await history.undo();
    expect(log.events).toEqual(["undo C", "undo B", "undo A"]);
  });

  it("releases every part when the entry leaves history", async () => {
    const log: Log = { events: [] };
    const history = new History();
    history.group("G", () => {
      history.record(command("A", log));
      history.record(command("B", log));
    });
    await history.undo();
    history.record(command("C", log));
    expect(log.events).toEqual(["undo B", "undo A", "release A", "release B"]);
  });

  it("puts back the parts already undone when one part fails", async () => {
    const log: Log = { events: [] };
    const history = new History();
    history.group("G", () => {
      history.record(command("A", log));
      history.record(command("B", log, { failUndo: true }));
      history.record(command("C", log));
    });

    await expect(history.undo()).rejects.toThrow("undo failed");
    expect(log.events).toEqual(["undo C", "redo C"]);
    expect(history.entries).toEqual([{ name: "G", applied: true }]);
    expect(history.canRedo).toBe(false);
  });

  it("undoes a compound built by hand the same way", async () => {
    const log: Log = { events: [] };
    const history = new History();
    history.record(compoundCommand("Manual", [command("A", log), command("B", log)]));
    await history.undo();
    await history.redo();
    expect(log.events).toEqual(["undo B", "undo A", "redo A", "redo B"]);
  });

  it("adds a non-undoable placeholder that undo never passes", async () => {
    const log: Log = { events: [] };
    const history = new History();
    history.record(command("A", log));
    history.recordPlaceholder("Null");

    expect(history.canUndo).toBe(false);
    expect(history.entries).toEqual([
      { name: "A", applied: true },
      { name: "Null", applied: true },
    ]);
    expect(await history.undo()).toBe(false);
  });
});
