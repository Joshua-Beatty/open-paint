import { describe, expect, it } from "vitest";
import { History, type HistoryCommand, type ToolStep } from "./history";

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

describe("History (DOC-HIS-01)", () => {
  it("starts empty and clean", () => {
    const history = new History();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.undoName).toBeUndefined();
    expect(history.isSaved).toBe(true);
    expect(history.entries).toEqual([]);
  });

  it("undoes and redoes items in order and reports their names", async () => {
    const log: Log = { events: [] };
    const history = new History();
    history.record(command("A", log));
    history.record(command("B", log));
    expect(history.undoName).toBe("B");

    expect(await history.undo()).toBe(true);
    expect(history.redoName).toBe("B");
    expect(history.undoName).toBe("A");
    expect(await history.redo()).toBe(true);
    expect(log.events).toEqual(["undo B", "redo B"]);
  });

  it("returns false when there is nothing to step over", async () => {
    const history = new History();
    expect(await history.undo()).toBe(false);
    expect(await history.redo()).toBe(false);
  });

  it("clears the redo stack and releases its items when a new item is recorded", async () => {
    const log: Log = { events: [] };
    const history = new History();
    history.record(command("A", log));
    history.record(command("B", log));
    await history.undo();
    history.record(command("C", log));
    expect(history.canRedo).toBe(false);
    expect(log.events).toEqual(["undo B", "release B"]);
    expect(history.entries.map((entry) => entry.name)).toEqual(["A", "C"]);
  });

  it("keeps a non-undoable base item that undo never passes", async () => {
    const log: Log = { events: [] };
    const history = new History("New Image");
    expect(history.canUndo).toBe(false);
    history.record(command("A", log));
    expect(await history.undo()).toBe(true);
    expect(history.canUndo).toBe(false);
    expect(await history.undo()).toBe(false);
    expect(history.entries).toEqual([
      { name: "New Image", applied: true },
      { name: "A", applied: false },
    ]);
  });

  it("is unlimited: depth is not capped", async () => {
    const log: Log = { events: [] };
    const history = new History();
    for (let i = 0; i < 2_000; i++) history.record(command(`item ${i}`, log));
    await history.seek(0);
    expect(history.canRedo).toBe(true);
    expect(history.entries).toHaveLength(2_000);
    await history.seek(2_000);
    expect(history.undoName).toBe("item 1999");
  });

  it("jumps to any position with seek, as the History panel does", async () => {
    const log: Log = { events: [] };
    const history = new History("base");
    for (const name of ["A", "B", "C"]) history.record(command(name, log));
    await history.seek(2);
    expect(history.undoName).toBe("A");
    expect(history.redoName).toBe("B");
    await history.seek(4);
    expect(history.undoName).toBe("C");
    await history.seek(0);
    expect(history.undoName).toBeUndefined();
  });

  it("leaves the stacks unchanged when an undo fails", async () => {
    const log: Log = { events: [] };
    const history = new History();
    history.record(command("A", log, { failUndo: true }));
    await expect(history.undo()).rejects.toThrow("undo failed");
    expect(history.undoName).toBe("A");
    expect(history.canRedo).toBe(false);
    expect(history.canUndo).toBe(true);
  });

  it("runs undo calls made while another undo runs, one after another", async () => {
    const history = new History();
    const undone: string[] = [];
    for (const name of ["first", "second"]) {
      history.record({
        name,
        undo: async () => {
          undone.push(name);
        },
        redo: async () => {},
        release: () => {},
      });
    }
    const one = history.undo();
    const two = history.undo();
    expect(await one).toBe(true);
    expect(await two).toBe(true);
    expect(undone).toEqual(["second", "first"]);
    expect(history.busy).toBe(false);
  });

  it("refuses to record while an undo or redo is running", async () => {
    const history = new History();
    let finish = () => {};
    history.record({
      name: "slow",
      undo: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      redo: async () => {},
      release: () => {},
    });
    const running = history.undo();
    expect(history.busy).toBe(true);
    expect(() => history.record(command("late", { events: [] }))).toThrow("busy");
    await new Promise((resolve) => setTimeout(resolve, 0));
    finish();
    await running;
    expect(history.canRedo).toBe(true);
  });

  it("releases every item when cleared", () => {
    const log: Log = { events: [] };
    const history = new History();
    history.record(command("A", log));
    history.record(command("B", log));
    history.clear();
    expect(log.events).toEqual(["release A", "release B"]);
    expect(history.entries).toEqual([]);
  });

  it("notifies listeners on every change and stops after unsubscribing", async () => {
    const log: Log = { events: [] };
    const history = new History();
    let calls = 0;
    const unsubscribe = history.subscribe(() => {
      calls++;
    });
    history.record(command("A", log));
    expect(calls).toBe(1);
    await history.undo();
    expect(calls).toBeGreaterThanOrEqual(2);
    unsubscribe();
    const before = calls;
    history.record(command("B", log));
    expect(calls).toBe(before);
  });
});

describe("saved position and the dirty flag (DOC-DOC-06)", () => {
  it("is clean again when undo returns to the saved position", async () => {
    const log: Log = { events: [] };
    const history = new History();
    history.record(command("A", log));
    history.markSaved();
    history.record(command("B", log));
    expect(history.isSaved).toBe(false);
    await history.undo();
    expect(history.isSaved).toBe(true);
    await history.redo();
    expect(history.isSaved).toBe(false);
  });

  it("stays dirty when the saved item is discarded by a new item", async () => {
    const log: Log = { events: [] };
    const history = new History();
    history.record(command("A", log));
    history.record(command("B", log));
    history.markSaved();
    await history.undo();
    history.record(command("C", log));
    expect(history.isSaved).toBe(false);
    await history.undo();
    expect(history.isSaved).toBe(false);
  });

  it("stays dirty while undoing past a later save", async () => {
    const log: Log = { events: [] };
    const history = new History();
    history.record(command("A", log));
    history.markSaved();
    history.record(command("B", log));
    history.markSaved();
    await history.undo();
    expect(history.isSaved).toBe(false);
    await history.undo();
    expect(history.isSaved).toBe(false);
  });

  it("treats a new document as clean and an undo to the base as clean", async () => {
    const history = new History("New Image");
    history.record(command("A", { events: [] }));
    expect(history.isSaved).toBe(false);
    await history.undo();
    expect(history.isSaved).toBe(true);
  });
});

describe("tool steps (TL-FRAME-01)", () => {
  const step = (tool: string, session: object, before: unknown, after: unknown): ToolStep => ({
    tool,
    layer: 0,
    kind: "edit",
    session,
    before,
    after,
  });

  it("keeps the tool step an item was recorded with, and none for other items", () => {
    const history = new History();
    const log: Log = { events: [] };
    const s = step("shapes", {}, 1, 2);
    const result = history.withStep(s, () => {
      expect(history.inStep).toBe(true);
      history.record(command("A", log));
      return 7;
    });
    expect(result).toBe(7);
    expect(history.inStep).toBe(false);
    history.record(command("B", log));
    const [a, b] = history.appliedCommands;
    expect(history.stepOf(a)).toBe(s);
    expect(history.stepOf(b)).toBeUndefined();
  });

  it("calls the stepper before an item is applied and after the stacks moved, both ways", async () => {
    const history = new History();
    const log: Log = { events: [] };
    const s = step("shapes", {}, "before", "after");
    history.withStep(s, () => history.record(command("A", log)));
    const seen: string[] = [];
    history.setStepper({
      before: (c, found, direction) => {
        seen.push(`before ${direction} ${c.name} ${String(found?.tool)} ${history.undoName}`);
      },
      after: async (c, found, direction) => {
        await Promise.resolve();
        seen.push(`after ${direction} ${c.name} ${String(found?.tool)} ${history.undoName}`);
      },
    });
    await history.undo();
    await history.redo();
    expect(seen).toEqual([
      "before undo A shapes A",
      "after undo A shapes undefined",
      "before redo A shapes undefined",
      "after redo A shapes A",
    ]);
    expect(log.events).toEqual(["undo A", "redo A"]);
  });

  it("tells the stepper about new items, and stops once removed", () => {
    const history = new History();
    const recorded: string[] = [];
    const remove = history.setStepper({
      recorded: (c, s) => recorded.push(`${c.name} ${s?.tool}`),
    });
    history.withStep(step("gradient", {}, undefined, 1), () =>
      history.record(command("A", { events: [] })),
    );
    remove();
    history.record(command("B", { events: [] }));
    expect(recorded).toEqual(["A gradient"]);
  });

  it("records a state-only step that changes nothing when undone or redone", async () => {
    const history = new History();
    const s = step("shapes", {}, 1, 2);
    const recorded = history.recordStep("Edit", s);
    expect(history.stepOf(recorded)).toBe(s);
    expect(await history.undo()).toBe(true);
    expect(await history.redo()).toBe(true);
  });
});
