import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BUILT_IN_REGISTRY } from "../commands/catalog";
import { CommandRegistry } from "../commands/registry";
import { KeyboardShortcuts } from "./KeyboardShortcuts";

function rowFor(name: string): HTMLElement {
  const row = screen.getByRole("rowheader", { name }).closest("tr");
  if (row === null) throw new Error(`No row for ${name}`);
  return row;
}

describe("Keyboard Shortcuts reference (SET-HELP-03)", () => {
  it("lists every menu group that has a shortcut, with the Command, Shortcut and Alternate columns", () => {
    render(
      <KeyboardShortcuts isOpen onClose={() => {}} registry={BUILT_IN_REGISTRY} platform="other" />,
    );
    expect(screen.getByRole("dialog", { name: "Keyboard Shortcuts" })).toBeDefined();
    for (const group of [
      "File",
      "Edit",
      "View",
      "Image",
      "Layers",
      "Adjustments",
      "Effects",
      "Tools",
      "Help",
    ]) {
      expect(screen.getByRole("heading", { level: 3, name: group })).toBeDefined();
    }
    const headers = screen
      .getAllByRole("columnheader")
      .slice(0, 3)
      .map((header) => header.textContent);
    expect(headers).toEqual(["Command", "Shortcut", "Alternate"]);
  });

  it("shows the primary bindings and the always-active alternates", () => {
    render(
      <KeyboardShortcuts isOpen onClose={() => {}} registry={BUILT_IN_REGISTRY} platform="other" />,
    );
    const newRow = rowFor("New");
    expect(newRow.textContent).toContain("Ctrl+N");
    expect(newRow.querySelectorAll("td")[1]?.textContent).toBe("Alt+N");
    expect(rowFor("Paste").querySelectorAll("td")[0]?.textContent).toBe("Ctrl+V / Shift+Insert");
    expect(rowFor("Zoom In").querySelectorAll("td")[0]?.textContent).toBe("Ctrl++ / Ctrl+=");
    expect(rowFor("Next Image Tab").querySelectorAll("td")[1]?.textContent).toBe(
      "Alt+Shift+PageDown",
    );
  });

  it("uses the platform's labels (WEB-KEY-06)", () => {
    render(
      <KeyboardShortcuts isOpen onClose={() => {}} registry={BUILT_IN_REGISTRY} platform="mac" />,
    );
    expect(rowFor("Save").querySelectorAll("td")[0]?.textContent).toBe("⌘S");
    expect(rowFor("Copy Selection").querySelectorAll("td")[0]?.textContent).toBe("⌥⇧⌘C");
  });

  it("omits commands that have no shortcut", () => {
    render(
      <KeyboardShortcuts
        isOpen
        onClose={() => {}}
        registry={
          new CommandRegistry([
            { id: "a", group: "file", messageId: "command.file.save", shortcuts: ["Ctrl+S"] },
            { id: "b", group: "file", messageId: "command.file.open", shortcuts: [] },
          ])
        }
        platform="other"
      />,
    );
    expect(screen.queryByRole("rowheader", { name: "Open" })).toBeNull();
    expect(screen.getByRole("rowheader", { name: "Save" })).toBeDefined();
    expect(screen.queryByRole("heading", { level: 3, name: "Edit" })).toBeNull();
  });

  it("filters the rows by command name or key label (SET-HELP-03 search)", () => {
    render(
      <KeyboardShortcuts isOpen onClose={() => {}} registry={BUILT_IN_REGISTRY} platform="other" />,
    );
    const search = screen.getByRole("searchbox", { name: "Search shortcuts" });
    fireEvent.change(search, { target: { value: "ctrl+s" } });
    expect(screen.getByRole("rowheader", { name: "Save" })).toBeDefined();
    expect(screen.queryByRole("rowheader", { name: "Open" })).toBeNull();
    fireEvent.change(search, { target: { value: "  SAVE  " } });
    expect(screen.getByRole("rowheader", { name: "Save" })).toBeDefined();
    fireEvent.change(search, { target: { value: "no such command" } });
    expect(screen.queryByRole("rowheader", { name: "Save" })).toBeNull();
    expect(screen.getByText("No shortcuts match your search.")).toBeDefined();
  });

  it("closes from the title bar's close button, its only Close, and Esc", () => {
    const onClose = vi.fn();
    render(
      <KeyboardShortcuts isOpen onClose={onClose} registry={BUILT_IN_REGISTRY} platform="other" />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.closest(".modal-header")).not.toBeNull();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
