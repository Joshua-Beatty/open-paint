import {
  canScroll,
  DEFAULT_ENGINE_SETTINGS,
  type EngineError,
  type EngineHandle,
  type EngineSettings,
  type EngineSize,
  type EngineStatus,
  engineError,
  GraphicsErrorFlags,
  layoutState,
  startEngine,
  type ViewCommand,
  type ViewLayout,
  type WheelInput,
} from "@openpaint/engine";
import { type RefObject, useEffect, useState } from "react";
import {
  AutoScrollPress,
  type AutoScrollSettings,
  autoScrollDelta,
  DEFAULT_AUTO_SCROLL,
} from "./auto-scroll";
import { noteViewInput, setViewDragging } from "./navigation";
import { PERF_FLAGS } from "./perf/flags";
import { perfMonitor } from "./perf/perf-monitor";
import type { DevicePoint } from "./status/status-model";
import type { ToolPointerSink } from "./tools/tool-pointer";
import { pinchCommand, type TouchSpan, touchSpan } from "./touch-pinch";
import { ViewPredictor } from "./view-predictor";

/** Where the engine reports the view layout and the pointer for the status bar (UI-SB-01). */
export interface EngineSink {
  setLayout(layout: ViewLayout | undefined): void;
  setPointer(point: DevicePoint | undefined): void;
}

export interface EngineState {
  readonly status: EngineStatus | undefined;
  /** The running engine, once it has started. Commands drive the view through it. */
  readonly engine: EngineHandle | undefined;
  /** No engine could start, not even v1 on the CPU: the canvas stays empty until a reload. */
  readonly failed: boolean;
}

/**
 * Engine v2 gave up its GPU (repeated device loss or failed presents). Its canvas is bound to
 * WebGPU, so v1 takes over on the CPU with a new canvas (WEB-GPU-05).
 */
export function needsCpuRestart(status: EngineStatus): boolean {
  return status.engine === "v2" && status.backend === "cpu";
}

/**
 * The settings engine v1 starts again with on a new canvas, when the running engine's canvas is
 * bound to the other backend's context (`EngineStatus.restartCanvas`, e.g. after a GPU fallback or
 * a backend change in Settings) or engine v2 gave up its GPU. Undefined when no restart is needed.
 */
export function canvasRestartSettings(status: EngineStatus): EngineSettings | undefined {
  if (needsCpuRestart(status)) {
    return {
      ...DEFAULT_ENGINE_SETTINGS,
      errorFlags: status.errorFlags | GraphicsErrorFlags.CpuFallbackAfterDeviceLoss,
    };
  }
  if (status.restartCanvas !== true) return undefined;
  return {
    backend: status.setting,
    errorFlags: status.errorFlags,
    performanceCache: status.performanceCache,
  };
}

/** How far Ctrl+Arrow scrolls in pan mode, in CSS pixels (UI-KEY-02). */
const PAN_STEP_CSS_PIXELS = 100;

/** The direction each arrow key moves the image, as a unit step (UI-KEY-02). */
const ARROW_PAN: Record<string, readonly [number, number]> = {
  ArrowLeft: [1, 0],
  ArrowRight: [-1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
};

function devicePixelSize(entry: ResizeObserverEntry): EngineSize {
  const box = entry.devicePixelContentBoxSize?.[0];
  const scale = devicePixelRatio;
  if (box) return { width: box.inlineSize, height: box.blockSize, scale };
  return {
    width: Math.round(entry.contentRect.width * scale),
    height: Math.round(entry.contentRect.height * scale),
    scale,
  };
}

/** The Back (X1, button 3) and Forward (X2, button 4) buttons, which browsers use for history. */
function isNavigationButton(button: number): boolean {
  return button === 3 || button === 4;
}

/** Maps a pointer or wheel position to device pixels inside the canvas (WEB-GPU-07). */
function devicePoint(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const box = canvas.getBoundingClientRect();
  const sx = box.width > 0 ? canvas.width / box.width : 1;
  const sy = box.height > 0 ? canvas.height / box.height : 1;
  return { x: (clientX - box.left) * sx, y: (clientY - box.top) * sy, sx, sy };
}

/**
 * Starts the engine worker on a canvas created inside `container` and keeps the canvas backing
 * store at the container's device-pixel size (WEB-GPU-07). The canvas is created here rather than
 * rendered by React because control of a canvas can be transferred to a worker only once.
 *
 * Canvas input goes to the engine: Ctrl+wheel zooms around the pointer, other wheel input scrolls
 * (UI-KEY-02). Middle-button drag and Space-held drag pan, and Space plus Ctrl+Arrow scrolls by
 * 100 CSS pixels. Space shows a "not-allowed" cursor when the image cannot scroll. The browser's
 * wheel zoom, middle-click autoscroll and context menu are suppressed on the canvas (WEB-PTR-05/06).
 * The view layout and the pointer position go to `sink` for the status bar. An uncaught worker
 * error goes to `onWorkerError` (SET-ERR-01). That callback must be stable, since a change restarts
 * the engine.
 *
 * Left, right and pen-eraser (button 5) drags that are not panning go to `tools` as pointer samples in canvas
 * pixels, with pointer capture, so a stroke continues outside the canvas (WEB-PTR-04). A left drag
 * pans instead while the active tool asks for it (the Pan tool, TL-PAN-01). The canvas cursor comes
 * from the active tool for the view state, the modifier keys and the last pointer sample, which
 * carries the zoom so tools hit-test their handles on screen. It is set on the canvas style only
 * when it changes. Space and middle-button drags override it (TL-HOTKEY-03).
 *
 * While a drawing tool holds the pointer, the view auto-scrolls near or past the canvas edge, using
 * `autoScrollSettings` (read on every frame). The Pan tool never auto-scrolls. The tool gets the last
 * pointer again after each step, so its stroke follows the view.
 *
 * Errors the worker caught or recovered from go to `onEngineError` (stable, like `onWorkerError`).
 * When engine v2 gives up its GPU (`needsCpuRestart`), the canvas and worker are replaced by v1 on
 * the CPU backend, with the fallback flag, so the device-loss notice shows. The same happens when
 * v1 moves to the backend its canvas's context cannot show (`EngineStatus.restartCanvas`), with
 * the status's settings. The document binding follows the new handle. When no engine starts at
 * all, `failed` is set.
 */
export function useEngine(
  container: RefObject<HTMLElement | null>,
  sink: EngineSink,
  onWorkerError?: (event: ErrorEvent) => void,
  tools?: ToolPointerSink,
  autoScrollSettings?: () => AutoScrollSettings,
  onEngineError?: (error: EngineError) => void,
): EngineState {
  const [status, setStatus] = useState<EngineStatus>();
  const [engineHandle, setEngineHandle] = useState<EngineHandle>();
  const [failed, setFailed] = useState(false);
  /** The settings v1 restarts with on a new canvas (`canvasRestartSettings`). */
  const [cpuRestart, setCpuRestart] = useState<EngineSettings>();

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.touchAction = "none";
    host.append(canvas);

    let engine: EngineHandle | undefined;
    let predictor: ViewPredictor | undefined;
    let observer: ResizeObserver | undefined;
    let disposed = false;
    let spaceHeld = false;
    let drag: { x: number; y: number } | undefined;
    const touches = new Map<number, { x: number; y: number }>();
    let pinch: TouchSpan | undefined;
    const pinchSpan = (): TouchSpan | undefined => {
      const [first, second] = touches.values();
      return first === undefined || second === undefined ? undefined : touchSpan(first, second);
    };
    let toolDown = false;
    let autoScroll:
      | { event: PointerEvent; time: number; frame: number; press: AutoScrollPress }
      | undefined;
    let layout: ViewLayout | undefined;
    const canPan = () =>
      layout !== undefined &&
      canScroll(
        layoutState(layout),
        { width: layout.documentWidth, height: layout.documentHeight },
        { width: canvas.width, height: canvas.height },
      );
    const modifiers = { ctrlKey: false, altKey: false, shiftKey: false };
    /** Follows the modifier keys of an input event. Returns whether one changed. */
    const trackModifiers = (event: MouseEvent | KeyboardEvent): boolean => {
      const changed =
        event.ctrlKey !== modifiers.ctrlKey ||
        event.altKey !== modifiers.altKey ||
        event.shiftKey !== modifiers.shiftKey;
      modifiers.ctrlKey = event.ctrlKey;
      modifiers.altKey = event.altKey;
      modifiers.shiftKey = event.shiftKey;
      return changed;
    };
    /** Sets the canvas cursor from the view state and the tool. Writes the style only on a change. */
    const updateCursor = () => {
      const panning = drag !== undefined;
      const view = { canPan: canPan(), panning, ...modifiers };
      const next = spaceHeld
        ? panning
          ? "grabbing"
          : view.canPan
            ? "grab"
            : "not-allowed"
        : (tools?.cursor(view) ?? (panning ? "grabbing" : ""));
      if (canvas.style.cursor !== next) canvas.style.cursor = next;
    };
    const toImage = (clientX: number, clientY: number) => {
      if (layout === undefined) return undefined;
      const point = devicePoint(canvas, clientX, clientY);
      return {
        x: (point.x - layout.originX) / layout.zoom,
        y: (point.y - layout.originY) / layout.zoom,
        scale: layout.zoom / point.sx,
      };
    };
    const autoScrollTick = (time: number) => {
      const scrolling = autoScroll;
      if (scrolling === undefined) return;
      const seconds = (time - scrolling.time) / 1000;
      scrolling.time = time;
      const bounds = canvas.getBoundingClientRect();
      const settings = autoScrollSettings?.() ?? DEFAULT_AUTO_SCROLL;
      // A press that is still a click never scrolls, however long it is held (TL-HOTKEY-03).
      const drawing = scrolling.press.armed && !(tools?.panOnDrag() ?? false);
      if (engine !== undefined && layout !== undefined && drawing) {
        const pointer = {
          x: scrolling.event.clientX - bounds.left,
          y: scrolling.event.clientY - bounds.top,
        };
        const delta = autoScrollDelta(pointer, bounds, settings, seconds);
        if (delta.dx !== 0 || delta.dy !== 0) {
          void predictor?.view({
            type: "pan",
            dx: delta.dx * devicePixelRatio,
            dy: delta.dy * devicePixelRatio,
          });
          tools?.pointer("move", scrolling.event, toImage);
        }
      }
      scrolling.frame = requestAnimationFrame(autoScrollTick);
    };
    const startAutoScroll = (event: PointerEvent) => {
      if (autoScroll !== undefined) {
        autoScroll.event = event;
        return;
      }
      autoScroll = { event, time: performance.now(), frame: 0, press: new AutoScrollPress(event) };
      autoScroll.frame = requestAnimationFrame(autoScrollTick);
    };
    const stopAutoScroll = () => {
      if (autoScroll === undefined) return;
      cancelAnimationFrame(autoScroll.frame);
      autoScroll = undefined;
    };
    const size: EngineSize = {
      width: Math.round(host.clientWidth * devicePixelRatio),
      height: Math.round(host.clientHeight * devicePixelRatio),
      scale: devicePixelRatio,
    };
    const perf = perfMonitor !== undefined;
    const engineVersion =
      PERF_FLAGS.engine === "v2" && cpuRestart === undefined ? ("v2" as const) : undefined;
    const options = {
      onWorkerError,
      perf,
      ...(engineVersion && { engine: engineVersion }),
      ...(PERF_FLAGS.gpuFault && { fault: PERF_FLAGS.gpuFault }),
    };
    const settings = cpuRestart;
    /** Starts v1 again on a new canvas when `status` asks for it. Returns whether it does. */
    const restartIfNeeded = (status: EngineStatus): boolean => {
      const next = canvasRestartSettings(status);
      if (next === undefined) return false;
      if (!disposed) setCpuRestart(next);
      return true;
    };
    const started = (handle: EngineHandle) => {
      engine = handle;
      const views = new ViewPredictor(
        handle,
        (next) => {
          layout = next;
          sink.setLayout(next);
          updateCursor();
        },
        size,
      );
      predictor = views;
      // The app's view commands go through the prediction too, so overlays follow them at once.
      const viewHandle: EngineHandle = Object.assign(Object.create(handle) as EngineHandle, {
        view: (command: ViewCommand) => {
          noteViewInput();
          return views.view(command);
        },
        wheel: (input: WheelInput) => {
          noteViewInput();
          return views.wheel(input);
        },
      });
      setEngineHandle(viewHandle);
      setFailed(false);
      setStatus(handle.status);
      handle.onStatus((next) => {
        if (!restartIfNeeded(next)) setStatus(next);
      });
      handle.onLayout((next) => views.reported(next));
      observer = new ResizeObserver(([entry]) => {
        if (!entry) return;
        const next = devicePixelSize(entry);
        views.resize(next);
        void handle.resize(next);
      });
      try {
        observer.observe(canvas, { box: "device-pixel-content-box" });
      } catch {
        observer.observe(canvas);
      }
    };
    void startEngine(canvas, size, settings, options).then(
      (handle) => {
        if (disposed) {
          handle.terminate();
          return;
        }
        if (onEngineError) handle.onError(onEngineError);
        if (restartIfNeeded(handle.status)) {
          handle.terminate();
          return;
        }
        started(handle);
      },
      (cause: unknown) => {
        if (disposed) return;
        onEngineError?.(engineError(cause));
        if (engineVersion === "v2") {
          setCpuRestart({
            ...DEFAULT_ENGINE_SETTINGS,
            errorFlags: GraphicsErrorFlags.CpuFallbackAfterDeviceLoss,
          });
        } else setFailed(true);
      },
    );

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!predictor) return;
      noteViewInput();
      const point = devicePoint(canvas, event.clientX, event.clientY);
      predictor.wheelPerFrame({
        x: point.x,
        y: point.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
      });
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "touch") {
        touches.set(event.pointerId, devicePoint(canvas, event.clientX, event.clientY));
        if (touches.size >= 2) {
          canvas.setPointerCapture(event.pointerId);
          if (pinch === undefined) {
            stopAutoScroll();
            if (toolDown) {
              toolDown = false;
              tools?.pointer("cancel", event, toImage);
            }
            drag = undefined;
          }
          pinch = pinchSpan();
          updateCursor();
          return;
        }
      }
      trackModifiers(event);
      const pans = event.button === 0 && (spaceHeld || (tools?.panOnDrag() ?? false));
      if (event.button !== 1 && !pans) {
        if (
          tools !== undefined &&
          (event.button === 0 || event.button === 2 || event.button === 5)
        ) {
          canvas.setPointerCapture(event.pointerId);
          toolDown = true;
          tools.pointer("down", event, toImage);
          startAutoScroll(event);
          updateCursor();
        }
        return;
      }
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      drag = { x: event.clientX, y: event.clientY };
      setViewDragging(true);
      updateCursor();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch" && touches.has(event.pointerId)) {
        touches.set(event.pointerId, devicePoint(canvas, event.clientX, event.clientY));
        if (pinch !== undefined) {
          const next = pinchSpan();
          const step = next === undefined ? undefined : pinchCommand(pinch, next);
          if (step !== undefined) {
            noteViewInput();
            void predictor?.view(step);
          }
          if (next !== undefined) pinch = next;
          return;
        }
      }
      const point = devicePoint(canvas, event.clientX, event.clientY);
      sink.setPointer({ x: point.x, y: point.y });
      trackModifiers(event);
      if (autoScroll !== undefined) {
        autoScroll.event = event;
        autoScroll.press.move(event);
      }
      if (!drag) {
        tools?.pointer("move", event, toImage);
        updateCursor();
      }
      if (!drag || !predictor) return;
      const previous = devicePoint(canvas, drag.x, drag.y);
      drag = { x: event.clientX, y: event.clientY };
      // One pan per frame, with the overlays moved in the same frame (L1).
      predictor.panPerFrame(point.x - previous.x, point.y - previous.y);
    };
    const onPointerLeave = () => sink.setPointer(undefined);
    const endDrag = () => {
      if (drag !== undefined) setViewDragging(false);
      drag = undefined;
      updateCursor();
    };
    const onToolRelease = (phase: "up" | "cancel", event: PointerEvent) => {
      stopAutoScroll();
      if (toolDown) {
        toolDown = false;
        tools?.pointer(phase, event, toImage);
      }
      endDrag();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (trackModifiers(event)) updateCursor();
      if (event.target !== document.body && event.target !== canvas) return;
      if (event.code === "Space") {
        if (event.repeat) return;
        event.preventDefault();
        if (toolDown || drag !== undefined) return;
        spaceHeld = true;
        updateCursor();
        return;
      }
      const step = ARROW_PAN[event.code];
      if (!spaceHeld || step === undefined || !event.ctrlKey || !predictor) return;
      event.preventDefault();
      const css = PAN_STEP_CSS_PIXELS * devicePixelRatio;
      noteViewInput();
      void predictor.view({ type: "pan", dx: step[0] * css, dy: step[1] * css });
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (trackModifiers(event)) updateCursor();
      if (event.code !== "Space") return;
      spaceHeld = false;
      updateCursor();
    };
    const onVisibility = () => void engine?.setVisible(!document.hidden);
    const suppress = (event: Event) => event.preventDefault();
    const onMouseDown = (event: MouseEvent) => {
      if (event.button === 1 || isNavigationButton(event.button)) event.preventDefault();
    };
    const onMouseUp = (event: MouseEvent) => {
      if (isNavigationButton(event.button)) event.preventDefault();
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeave);
    const endTouch = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      touches.delete(event.pointerId);
      if (touches.size < 2) pinch = undefined;
    };
    const onPointerUp = (event: PointerEvent) => {
      endTouch(event);
      onToolRelease("up", event);
    };
    const onPointerCancel = (event: PointerEvent) => {
      endTouch(event);
      onToolRelease("cancel", event);
    };
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas.addEventListener("contextmenu", suppress);
    canvas.addEventListener("auxclick", suppress);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      predictor?.dispose();
      stopAutoScroll();
      observer?.disconnect();
      engine?.terminate();
      setEngineHandle(undefined);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("contextmenu", suppress);
      canvas.removeEventListener("auxclick", suppress);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.remove();
    };
  }, [container, sink, onWorkerError, tools, autoScrollSettings, onEngineError, cpuRestart]);

  return { status, engine: engineHandle, failed };
}
