// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRIP_ITEM_ATTRIBUTE } from "../properties/layout-context";
import { OVERFLOWED_ATTRIBUTE, OverflowRow } from "./OverflowRow";

const ITEM = { [STRIP_ITEM_ATTRIBUTE]: "" };
let rowWidth = 250;

beforeEach(() => {
  // jsdom has no layout: every item is 100 px wide, and the row is `rowWidth` wide.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const width = this.hasAttribute(STRIP_ITEM_ATTRIBUTE) ? 100 : 30;
    return { width, height: 28, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 28 } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("overflow-row") ? rowWidth : 0;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderRow() {
  render(
    <OverflowRow moreLabel="More options">
      <div>
        <button type="button" {...ITEM}>
          First
        </button>
        <button type="button" {...ITEM}>
          Second
        </button>
      </div>
      <button type="button" {...ITEM}>
        Third
      </button>
    </OverflowRow>,
  );
}

describe("OverflowRow", () => {
  it("shows every item and no More button when the row is wide enough", () => {
    rowWidth = 400;
    renderRow();
    expect(document.querySelectorAll(`[${OVERFLOWED_ATTRIBUTE}]`)).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "More options" })).toBeNull();
  });

  it("hides the items that do not fit and lists only them in the More menu", () => {
    rowWidth = 250;
    renderRow();
    const third = screen.getByRole("button", { name: "Third" });
    expect(third.hasAttribute(OVERFLOWED_ATTRIBUTE)).toBe(true);
    expect(third.inert).toBe(true);
    expect(screen.getByRole("button", { name: "Second" }).hasAttribute(OVERFLOWED_ATTRIBUTE)).toBe(
      false,
    );

    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    const menu = screen.getByRole("dialog", { name: "More options" });
    const shown = [...menu.querySelectorAll<HTMLElement>(`[${STRIP_ITEM_ATTRIBUTE}]`)]
      .filter((item) => !item.hidden)
      .map((item) => item.textContent);
    expect(shown).toEqual(["Third"]);
  });
});
