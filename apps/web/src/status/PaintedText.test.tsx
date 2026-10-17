import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCESSIBLE_TEXT_DELAY_MS, fitText, PaintedText } from "./PaintedText";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("fitText", () => {
  const measure = (text: string) => text.length * 10;

  it("keeps text that fits and cuts the rest with an ellipsis", () => {
    expect(fitText("12, 34", 60, measure)).toBe("12, 34");
    expect(fitText("Selection top left", 60, measure)).toBe("Selec…");
    expect(fitText("abc", 5, measure)).toBe("");
  });
});

describe("PaintedText", () => {
  it("changes no DOM text per update; the accessible copy follows once the text is steady", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<PaintedText text="1, 1" live />);
    const spoken = container.querySelector("[aria-live]");
    expect(spoken?.textContent).toBe("1, 1");
    const changes: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) changes.push(record.type);
    });
    observer.observe(container, { subtree: true, childList: true, characterData: true });
    for (let x = 2; x < 30; x++) {
      rerender(<PaintedText text={`${x}, 1`} live />);
      act(() => vi.advanceTimersByTime(16));
    }
    expect(spoken?.textContent).toBe("1, 1");
    act(() => vi.advanceTimersByTime(ACCESSIBLE_TEXT_DELAY_MS));
    expect(spoken?.textContent).toBe("29, 1");
    // One DOM change for the whole drag: the steady value.
    for (const record of observer.takeRecords()) changes.push(record.type);
    expect(changes.length).toBeLessThanOrEqual(2);
    observer.disconnect();
  });
});
