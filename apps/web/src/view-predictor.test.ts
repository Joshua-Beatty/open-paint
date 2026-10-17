import {
  applyCommand,
  applyWheel,
  FIT_VIEW,
  type ViewCommand,
  type ViewLayout,
  type ViewState,
  type ViewStatus,
  viewLayout,
  viewStatus,
  type WheelInput,
} from "@openpaint/engine";
import { describe, expect, it } from "vitest";
import { ViewPredictor, type ViewTarget } from "./view-predictor";

const VIEWPORT = { width: 1000, height: 700, scale: 1 };

/** An engine stand-in: it applies commands with the real view functions when `answer` runs. */
class FakeEngine implements ViewTarget {
  state: ViewState = FIT_VIEW;
  doc = { width: 4000, height: 3000 };
  readonly sent: (ViewCommand | WheelInput)[] = [];
  readonly #queue: (() => void)[] = [];
  onLayout: (layout: ViewLayout) => void = () => {};

  get layout(): ViewLayout {
    return viewLayout(this.state, this.doc, VIEWPORT);
  }

  view(command: ViewCommand): Promise<ViewStatus> {
    this.sent.push(command);
    return this.#enqueue(() => applyCommand(this.state, this.doc, VIEWPORT, command));
  }

  wheel(input: WheelInput): Promise<ViewStatus> {
    this.sent.push(input);
    return this.#enqueue(() => applyWheel(this.state, this.doc, VIEWPORT, VIEWPORT.scale, input));
  }

  /** Handles the oldest message: the layout report comes before the answer, as in the worker. */
  async answer(): Promise<void> {
    this.#queue.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
  }

  #enqueue(apply: () => ViewState): Promise<ViewStatus> {
    return new Promise((resolve) => {
      this.#queue.push(() => {
        this.state = apply();
        this.onLayout(this.layout);
        resolve(viewStatus(this.state, this.doc, VIEWPORT));
      });
    });
  }
}

function setup() {
  const engine = new FakeEngine();
  const published: ViewLayout[] = [];
  const frames: (() => void)[] = [];
  const predictor = new ViewPredictor(
    engine,
    (layout) => published.push(layout),
    VIEWPORT,
    (callback) => frames.push(callback),
    () => {},
  );
  engine.onLayout = (layout) => predictor.reported(layout);
  predictor.reported(engine.layout);
  const frame = () => {
    const due = frames.splice(0);
    for (const callback of due) callback();
  };
  return { engine, published, predictor, frame };
}

describe("ViewPredictor", () => {
  it("publishes the engine's next layout when a command is sent, before the engine answers", async () => {
    const { engine, published, predictor } = setup();
    void predictor.view({ type: "zoom", ratio: 2 });
    const predicted = published.at(-1);
    expect(predicted?.zoom).toBe(2);
    await engine.answer();
    expect(engine.layout).toEqual(predicted);
    expect(published.at(-1)).toEqual(predicted);
  });

  it("sends a frame's first pan at once and combines the rest into one at the next frame", async () => {
    const { engine, published, predictor, frame } = setup();
    void predictor.view({ type: "zoom", ratio: 2 });
    await engine.answer();
    const before = predictor.layout;
    predictor.panPerFrame(10, 5);
    expect(engine.sent.at(-1)).toEqual({ type: "pan", dx: 10, dy: 5 });
    expect(predictor.layout?.originX).toBe((before?.originX ?? 0) + 10);
    predictor.panPerFrame(15, -2);
    predictor.panPerFrame(5, 1);
    expect(engine.sent).toHaveLength(2);
    frame();
    expect(engine.sent.at(-1)).toEqual({ type: "pan", dx: 20, dy: -1 });
    expect(predictor.layout?.originX).toBe((before?.originX ?? 0) + 30);
    const shown = published.length;
    await engine.answer();
    await engine.answer();
    // The engine's answers match the prediction, so nothing is published again.
    expect(published).toHaveLength(shown);
    expect(engine.layout).toEqual(predictor.layout);
    // A frame with no input ends the throttle, so the next pan goes out at once.
    frame();
    predictor.panPerFrame(1, 1);
    expect(engine.sent).toHaveLength(4);
  });

  it("predicts a run of commands and wheel steps the engine has not answered yet", async () => {
    const { engine, predictor, frame } = setup();
    void predictor.view({ type: "actualSize" });
    void predictor.view({ type: "pan", dx: -300, dy: 120 });
    predictor.wheelPerFrame({
      x: 400,
      y: 300,
      deltaX: 0,
      deltaY: -100,
      deltaMode: 0,
      ctrlKey: true,
      shiftKey: false,
    });
    predictor.wheelPerFrame({
      x: 400,
      y: 300,
      deltaX: 0,
      deltaY: -100,
      deltaMode: 0,
      ctrlKey: true,
      shiftKey: false,
    });
    frame();
    expect(engine.sent).toHaveLength(4);
    const predicted = predictor.layout;
    for (let i = 0; i < 4; i++) await engine.answer();
    expect(engine.layout).toEqual(predicted);
  });

  it("keeps wheel zooms at different points apart", () => {
    const { engine, predictor, frame } = setup();
    const zoomAt = (x: number) => ({
      x,
      y: 300,
      deltaX: 0,
      deltaY: -100,
      deltaMode: 0,
      ctrlKey: true,
      shiftKey: false,
    });
    predictor.wheelPerFrame(zoomAt(100));
    predictor.wheelPerFrame(zoomAt(100));
    predictor.wheelPerFrame(zoomAt(100));
    predictor.wheelPerFrame(zoomAt(200));
    frame();
    expect(engine.sent).toEqual([zoomAt(100), { ...zoomAt(100), deltaY: -200 }, zoomAt(200)]);
  });

  it("takes the engine's layout when it differs from the prediction", async () => {
    const { engine, predictor } = setup();
    void predictor.view({ type: "zoom", ratio: 1 });
    engine.doc = { width: 500, height: 400 };
    await engine.answer();
    expect(predictor.layout?.documentWidth).toBe(500);
    expect(predictor.layout).toEqual(engine.layout);
  });

  it("predicts overscroll pans from fit mode on a small image as the engine applies them", async () => {
    const { engine, predictor, frame } = setup();
    engine.doc = { width: 200, height: 100 };
    void predictor.view({ type: "overscroll", enabled: true });
    await engine.answer();
    // The settled report must carry overscroll on, or the next prediction would keep it centred.
    expect(engine.layout.overscroll).toBe(true);
    predictor.panPerFrame(4000, 30);
    predictor.panPerFrame(-10, 5);
    frame();
    const predicted = predictor.layout;
    expect(predicted?.mode).toBe("fixed");
    // The first pan stops at the clamp (the left edge at the centre, 500), then comes back 10.
    expect(predicted?.originX).toBe(490);
    await engine.answer();
    await engine.answer();
    expect(engine.layout).toEqual(predicted);
    expect(predictor.layout).toEqual(predicted);
  });

  it("applies a report that comes with no command in flight, such as a new image", () => {
    const { engine, predictor, published } = setup();
    engine.doc = { width: 64, height: 64 };
    predictor.reported(engine.layout);
    expect(published.at(-1)?.documentWidth).toBe(64);
  });
});
