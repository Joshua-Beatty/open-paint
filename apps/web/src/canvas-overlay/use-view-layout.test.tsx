import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatusStore } from "../status/status-store";
import { useViewLayout } from "./use-view-layout";

const LAYOUT = {
  mode: "fit" as const,
  zoom: 0.5,
  originX: 0,
  originY: 0,
  documentWidth: 300,
  documentHeight: 200,
};

afterEach(cleanup);

describe("useViewLayout (L3)", () => {
  it("re-renders on layout changes only, not on pointer moves", () => {
    const store = new StatusStore();
    let renders = 0;
    function Probe() {
      renders += 1;
      const layout = useViewLayout(store);
      return <span>{layout?.zoom ?? "none"}</span>;
    }
    const { container } = render(<Probe />);
    expect(renders).toBe(1);
    act(() => store.setPointer({ x: 1, y: 2 }));
    act(() => store.setPointer({ x: 3, y: 4 }));
    expect(renders).toBe(1);
    act(() => store.setLayout(LAYOUT as never));
    expect(renders).toBe(2);
    expect(container.textContent).toBe("0.5");
  });
});
