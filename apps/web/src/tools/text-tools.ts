import {
  bytesOf,
  type ColorRgba8,
  convertResolution,
  type Document,
  type HistoryCommand,
  intersectRects,
  isEmptyRect,
  type Layer,
  type Rect,
  rect,
  Surface,
} from "@openpaint/document";
import { clipToCoverage } from "@openpaint/effects";
import {
  CanvasTextEngine,
  compositeRgba8,
  type TextEngine,
  type TextFace,
  type TextRasterLine,
  type TextRenderingMode,
} from "@openpaint/engine";
import type { ToolPointerEvent, ToolRuntime, ToolViewState } from "@openpaint/extension-api";
import type { SettingChange } from "@openpaint/storage";
import { type TextAlignment, TextBlock, type TextMetrics, type TextPoint } from "@openpaint/tools";
import { PRIMARY_COLOR_PATH, readStoredColor } from "../colors/use-colors";
import {
  formatMeasure,
  measureUnit,
  unitAbbreviation,
  unitsPerPixel,
} from "../status/status-model";
import type { TextFonts } from "../text/font-catalog";
import { fontCatalog } from "../text/font-store";
import { fontSizePx, textStyles } from "../text/text-options";
import {
  GRAB_CURSOR,
  GRABBING_CURSOR,
  nearHandle,
  TEXT_EDIT_CURSOR,
  TEXT_PLACE_CURSOR,
} from "./cursors";
import { FrameCoalescer } from "./frame-coalescer";
import { LayerSnapshot } from "./layer-patch";
import { blendValue, OVERWRITE_BLEND, selectionCoverage } from "./paint-stroke";
import type { PaintHost } from "./paint-tools";
import { type TextBox, type TextCaret, textHandles } from "./text-handles";
import {
  domTextInputFactory,
  type TextInputFactory,
  type TextInputHandlers,
  type TextInputPort,
  type TextKey,
} from "./text-input";
import { reportToolFailure } from "./tool-failure";

const BLACK: ColorRgba8 = { r: 0, g: 0, b: 0, a: 255 };

/** The caret blinks every 300 ms (TL-TEXT-01). */
const CARET_BLINK_MS = 300;

/** The default font size in points (WEB-FONT-02). */
const DEFAULT_POINTS = 12;

/** The settings that change how the text is drawn, so a change re-renders the text (TL-TEXT-01). */
const LIVE_OPTIONS: ReadonlySet<string> = new Set([
  "tools.antialiasing",
  "tools.blendMode",
  "tools.selection.renderingQuality",
]);

/** What the Text tool renders with. Tests pass fakes for the canvas, the fonts and the input. */
export interface TextToolDeps {
  readonly engine: TextEngine;
  readonly fonts: TextFonts;
  readonly input: TextInputFactory;
}

let sharedEngine: CanvasTextEngine | undefined;

/** The deps of the running app. Nothing touches the DOM until the tool is first used. */
function browserDeps(host: PaintHost): TextToolDeps {
  sharedEngine ??= new CanvasTextEngine();
  return {
    engine: sharedEngine,
    fonts: fontCatalog,
    input: domTextInputFactory(host.translate("tool.text.inputLabel")),
  };
}

/** The settings a text render reads, resolved to the values the engine takes. */
interface TextStyleOptions {
  readonly face: TextFace;
  readonly mode: TextRenderingMode;
  readonly alignment: TextAlignment;
  readonly underline: boolean;
  readonly strikeout: boolean;
  readonly aliased: boolean;
  readonly pixelated: boolean;
  readonly blend: number;
  readonly color: ColorRgba8;
}

/** The text being edited: one history item once it is committed (TL-TEXT-01). */
interface TextSession {
  readonly document: Document;
  readonly layer: Layer;
  /** The layer before the text was typed. Every preview is composed from it. */
  readonly base: LayerSnapshot;
  /** The last history item when the text started. Any other applied item ends the session. */
  readonly top: HistoryCommand | undefined;
  readonly block: TextBlock;
  /** The IME composition in progress, shown at the caret but not yet typed. */
  preedit: string | undefined;
  /** The region of the layer that shows the preview: only the last one, the earlier are restored. */
  drawn: Rect | undefined;
  box: TextBox | undefined;
  caret: TextCaret | undefined;
  caretOn: boolean;
  ctrlHeld: boolean;
  drag: { readonly grab: TextPoint; readonly from: TextPoint } | undefined;
  timer: ReturnType<typeof setInterval> | undefined;
}

/** One composed preview: the layer region it covers, what it shows there, and the handles. */
interface Composed {
  readonly area: Rect;
  readonly painted: Surface;
  readonly box: TextBox;
  readonly caret: TextCaret;
}

function insideBox(point: TextPoint, box: TextBox): boolean {
  return (
    point.x >= box.x - 2 &&
    point.x <= box.x + box.width + 2 &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}

/**
 * The runtime of the Text tool (TL-TEXT-01). A click places a text block, and typing edits it in a
 * hidden text input, so IME composition and paste work. The text is drawn into the layer as a
 * preview while it is edited, with no history. Esc, Ctrl+Enter, the Finish button, a tool switch
 * and a click outside the block commit it as one "Text" item. Enter inserts a line break. The
 * block's anchor moves with the move handle at its top right corner.
 */
class TextRuntime implements ToolRuntime {
  readonly #host: PaintHost;
  readonly #deps: TextToolDeps;
  #session: TextSession | undefined;
  #input: TextInputPort | undefined;
  #unsubscribeSettings: (() => void) | undefined;
  #unsubscribeFonts: (() => void) | undefined;
  /** Draws a move of the text once per frame, at the latest pointer position (L1). */
  readonly #frames: FrameCoalescer;
  /** Draws the text in a new primary color once per frame, however often the color changes (L1). */
  readonly #recolor: FrameCoalescer;
  /** The last pointer sample, which the cursor is chosen for. */
  #hover: ToolPointerEvent | undefined;

  constructor(host: PaintHost, deps: TextToolDeps) {
    this.#host = host;
    this.#deps = deps;
    this.#frames = new FrameCoalescer(host.scheduleFrame);
    this.#recolor = new FrameCoalescer(host.scheduleFrame);
  }

  activate(): void {
    this.#unsubscribeSettings = this.#host
      .settings()
      ?.onChange((change) => this.#optionChanged(change));
    this.#unsubscribeFonts = this.#deps.fonts.subscribe(() => this.#rerender());
    this.#preloadFace();
  }

  deactivate(): void {
    this.commit();
    this.#unsubscribeSettings?.();
    this.#unsubscribeSettings = undefined;
    this.#unsubscribeFonts?.();
    this.#unsubscribeFonts = undefined;
    this.#input?.dispose();
    this.#input = undefined;
  }

  pointer(event: ToolPointerEvent): void {
    if (event.predicted !== true) this.#hover = event;
    try {
      if (event.type === "down") this.#down(event);
      else if (event.type === "move") this.#move(event);
      else this.#release();
    } catch (cause) {
      this.#fail(cause);
    }
  }

  /**
   * An I-beam over the text being edited, an open hand over its move handle (closed while it is
   * dragged), and the text-placement cursor elsewhere, where a click starts a new block.
   */
  cursor(view: ToolViewState): string | undefined {
    if (view.panning) return undefined;
    const session = this.#live();
    if (session?.drag !== undefined) return GRABBING_CURSOR;
    const hover = this.#hover;
    const box = session?.box;
    if (session === undefined || hover === undefined || box === undefined) {
      return TEXT_PLACE_CURSOR;
    }
    const ctrl = view.ctrlKey ?? session.ctrlHeld;
    if (!ctrl && nearHandle(hover, handleOf(box))) return GRAB_CURSOR;
    return insideBox(hover, box) ? TEXT_EDIT_CURSOR : TEXT_PLACE_CURSOR;
  }

  hasPending(): boolean {
    return this.#live() !== undefined;
  }

  /** Commits the text as one "Text" item (TL-TEXT-01). */
  commit(): void {
    const session = this.#live();
    if (session === undefined) return;
    try {
      this.#finish(session);
    } catch (cause) {
      this.#fail(cause);
    }
  }

  /** Esc commits the text as well, since the text is kept until it is committed. */
  cancel(): void {
    this.commit();
  }

  /** The Paste fallback (UI-MENU-EDIT): a text block that is being edited takes pasted text. */
  acceptsPaste(): boolean {
    return this.#live() !== undefined;
  }

  paste(text: string): void {
    if (this.#live() === undefined) return;
    this.#typed((block) => block.insert(text));
    this.#focus();
  }

  #down(event: ToolPointerEvent): void {
    if (event.button !== 0) return;
    const point = { x: event.x, y: event.y };
    const session = this.#live();
    if (session !== undefined) {
      this.#setCtrl(session, event.ctrlKey);
      const handle = session.box === undefined ? undefined : handleOf(session.box);
      if (handle !== undefined && !session.ctrlHeld && nearHandle(event, handle)) {
        session.drag = { grab: point, from: session.block.anchor };
        return;
      }
      const options = this.#options(session);
      if (options !== undefined && session.box !== undefined && insideBox(point, session.box)) {
        session.block.caretAt(point, this.#metrics(options), options.alignment);
        session.caretOn = true;
        this.#render(session);
        this.#focus();
        return;
      }
      this.commit();
    }
    this.#begin(point, event.ctrlKey);
  }

  #move(event: ToolPointerEvent): void {
    if (event.predicted === true) return;
    const session = this.#live();
    if (session === undefined) return;
    this.#setCtrl(session, event.ctrlKey);
    const drag = session.drag;
    if (drag === undefined) return;
    const dx = event.x - drag.grab.x;
    const dy = event.y - drag.grab.y;
    session.block.setAnchor({ x: Math.round(drag.from.x + dx), y: Math.round(drag.from.y + dy) });
    this.#frames.request(() => {
      if (this.#live() === session) this.#render(session);
    });
  }

  #release(): void {
    this.#frames.flush();
    const session = this.#session;
    if (session !== undefined) session.drag = undefined;
  }

  /** Starts a text block at a point. The text is empty until typed. */
  #begin(point: TextPoint, ctrlHeld: boolean): void {
    const settings = this.#host.settings();
    const document = this.#host.document();
    const layer = document?.activeLayer;
    if (settings === null || document === undefined || layer === undefined) return;
    const session: TextSession = {
      document,
      layer,
      base: new LayerSnapshot(layer.pixels),
      top: document.history.appliedCommands.at(-1),
      block: new TextBlock({ x: Math.floor(point.x), y: Math.floor(point.y) }),
      preedit: undefined,
      drawn: undefined,
      box: undefined,
      caret: undefined,
      caretOn: true,
      ctrlHeld,
      drag: undefined,
      timer: undefined,
    };
    session.timer = setInterval(() => {
      session.caretOn = !session.caretOn;
      this.#show(session);
    }, CARET_BLINK_MS);
    this.#session = session;
    this.#render(session);
    this.#focus();
  }

  /**
   * Gives the keyboard to the text input. A pointer down on the canvas moves the focus after the
   * tool has handled it, so the input takes the focus again once the event has finished.
   */
  #focus(): void {
    this.#input ??= this.#deps.input(this.#handlers());
    this.#input.focus();
    setTimeout(() => {
      if (this.#session !== undefined) this.#input?.focus();
    }, 0);
  }

  #handlers(): TextInputHandlers {
    return {
      key: (key) => this.#key(key),
      keyUp: (code) => this.#keyUp(code),
      text: (text) => this.#typed((block) => block.insert(text)),
      composition: (preedit) => this.#composing(preedit),
      paste: (text) => this.#typed((block) => block.insert(text)),
    };
  }

  /** Runs an editing key or a typed character. Returns whether the text took it. */
  #key(key: TextKey): boolean {
    const session = this.#live();
    if (session === undefined) return false;
    const word = key.ctrlKey;
    switch (key.code) {
      case "Escape":
        this.commit();
        return true;
      case "Enter":
      case "NumpadEnter":
        if (key.ctrlKey) {
          this.commit();
          return true;
        }
        return this.#edit(session, (block) => block.insert("\n"));
      case "Backspace":
        return this.#edit(session, (block) => block.deleteBackward(word));
      case "Delete":
        return this.#edit(session, (block) => block.deleteForward(word));
      case "ArrowLeft":
        return this.#edit(session, (block) => block.moveLeft(word));
      case "ArrowRight":
        return this.#edit(session, (block) => block.moveRight(word));
      case "ArrowUp":
      case "ArrowDown": {
        const delta = key.code === "ArrowUp" ? -1 : 1;
        return this.#edit(session, (block, options) =>
          block.moveVertical(delta, this.#metrics(options), options.alignment),
        );
      }
      case "Home":
        return this.#edit(session, (block) => block.moveHome());
      case "End":
        return this.#edit(session, (block) => block.moveEnd());
      case "ControlLeft":
      case "ControlRight":
        this.#setCtrl(session, true);
        return false;
      default:
        return false;
    }
  }

  #keyUp(code: string): void {
    const session = this.#live();
    if (session !== undefined && (code === "ControlLeft" || code === "ControlRight")) {
      this.#setCtrl(session, false);
    }
  }

  #typed(change: (block: TextBlock) => void): void {
    const session = this.#live();
    if (session !== undefined) this.#edit(session, change);
  }

  /** The IME composition shows at the caret until it ends (WEB-FONT, TL-TEXT-01). */
  #composing(preedit: string | undefined): void {
    const session = this.#live();
    if (session === undefined) return;
    session.preedit = preedit;
    this.#render(session);
  }

  #edit(
    session: TextSession,
    change: (block: TextBlock, options: TextStyleOptions) => void,
  ): boolean {
    const options = this.#options(session);
    if (options === undefined) return false;
    change(session.block, options);
    this.#render(session);
    return true;
  }

  /** The settings the text is drawn with, or undefined when the settings are not open. */
  #options(session: TextSession): TextStyleOptions | undefined {
    const settings = this.#host.settings();
    if (settings === null) return undefined;
    const read = (name: string) => settings.get(`tools.${name}`);
    const styles = textStyles(read("text.fontStyle"));
    const points = read("text.fontSize");
    const dpi = convertResolution(session.document.resolution, "inch").x;
    const alignment = read("text.alignment");
    const mode = read("text.renderingMode");
    return {
      face: {
        family: this.#deps.fonts.resolve(read("text.fontFamily")),
        sizePx: fontSizePx(
          typeof points === "number" && points > 0 ? points : DEFAULT_POINTS,
          read("text.fontSizeMetric"),
          dpi,
        ),
        bold: styles.has("Bold"),
        italic: styles.has("Italic"),
      },
      mode: mode === "Sharp" || mode === "Classic" ? mode : "Smooth",
      alignment: alignment === "Center" || alignment === "Right" ? alignment : "Left",
      underline: styles.has("Underline"),
      strikeout: styles.has("Strikeout"),
      aliased: read("antialiasing") === false,
      pixelated: read("selection.renderingQuality") === "Aliased",
      blend: blendValue(read("blendMode")),
      color: readStoredColor(settings, PRIMARY_COLOR_PATH, BLACK),
    };
  }

  #metrics(options: TextStyleOptions): TextMetrics {
    const font = this.#deps.engine.metrics(options.face);
    return {
      measure: (text) => this.#deps.engine.measure(text, options.face, options.mode),
      ascent: font.ascent,
      lineHeight: Math.max(1, font.ascent + font.descent),
    };
  }

  /**
   * The preview of the text: its glyph mask composed over the layer before the text, with the
   * blend mode and the selection clip, over the text's own rectangle (L2). Callers put the base
   * back over the last preview first, so nothing is left behind when the text shrinks or moves.
   */
  #compose(session: TextSession, options: TextStyleOptions): Composed | undefined {
    const display = this.#displayBlock(session);
    const metrics = this.#metrics(options);
    const layout = display.layout(metrics, options.alignment);
    const { face } = options;
    // Drawn in the fallback until the face's files are in; the font listener then draws it again.
    this.#deps.fonts.ensure(face, layout.lines.map((line) => line.text).join(""));
    const pad = Math.ceil(face.sizePx / 2) + 2;
    const anchor = session.block.anchor;
    const left = Math.floor(anchor.x) - pad;
    const top = Math.floor(anchor.y) - pad;
    const width = Math.ceil(layout.width) + pad * 2 + 1;
    const height = Math.ceil(layout.height) + pad * 2;
    const lines: TextRasterLine[] = layout.lines.map((line) => ({
      text: line.text,
      x: line.x - left,
      baseline: line.y + metrics.ascent - top,
      width: line.width,
    }));
    const mask = this.#deps.engine.rasterize({
      face,
      mode: options.mode,
      aliased: options.aliased,
      underline: options.underline,
      strikeout: options.strikeout,
      lines,
      width,
      height,
    });
    const area = intersectRects(rect(left, top, width, height), session.layer.pixels.bounds);
    if (isEmptyRect(area)) return undefined;
    const original = session.base.read(area);
    const painted = new Surface(area.width, area.height);
    painted.copyFrom(original, original.bounds, 0, 0);
    const glyphs = new Surface(area.width, area.height);
    const { r, g, b } = options.color;
    // The glyph pixels are written as bytes; per-pixel color objects cost more than the text (O16).
    const glyphBytes = glyphs.data;
    for (let row = 0; row < mask.height; row++) {
      const y = top + row - area.y;
      if (y < 0 || y >= area.height) continue;
      for (let column = 0; column < mask.width; column++) {
        const coverage = mask.alpha[row * mask.width + column] ?? 0;
        const x = left + column - area.x;
        if (coverage === 0 || x < 0 || x >= area.width) continue;
        const at = (y * area.width + x) * 4;
        glyphBytes[at] = r;
        glyphBytes[at + 1] = g;
        glyphBytes[at + 2] = b;
        glyphBytes[at + 3] = coverage;
      }
    }
    if (options.blend === OVERWRITE_BLEND) {
      const paintedBytes = painted.data;
      for (let at = 0; at < glyphBytes.length; at += 4) {
        if ((glyphBytes[at + 3] ?? 0) === 0) continue;
        paintedBytes[at] = glyphBytes[at] ?? 0;
        paintedBytes[at + 1] = glyphBytes[at + 1] ?? 0;
        paintedBytes[at + 2] = glyphBytes[at + 2] ?? 0;
        paintedBytes[at + 3] = glyphBytes[at + 3] ?? 0;
      }
    } else {
      compositeRgba8(bytesOf(painted), bytesOf(glyphs), options.blend, 255);
    }
    const coverage = selectionCoverage(session.document.selection, area, options.pixelated);
    return {
      area,
      painted: coverage === undefined ? painted : clipToCoverage(original, painted, coverage),
      box: {
        x: anchor.x,
        y: anchor.y,
        width: layout.width,
        height: Math.max(layout.height, metrics.lineHeight),
      },
      caret: layout.caret,
    };
  }

  /** The block as it is drawn: the typed text, with an IME composition inserted at the caret. */
  #displayBlock(session: TextSession): TextBlock {
    if (session.preedit === undefined) return session.block;
    const display = session.block.clone();
    display.insert(session.preedit);
    return display;
  }

  /** Writes the preview of the current text into the layer, without history. */
  #render(session: TextSession): void {
    const options = this.#options(session);
    if (options !== undefined) {
      const composed = this.#compose(session, options);
      const { drawn } = session;
      if (composed !== undefined || drawn !== undefined) {
        session.document.previewLayerPixels(session.layer, (pixels) => {
          if (drawn !== undefined) session.base.restore(pixels, drawn);
          if (composed !== undefined) {
            pixels.writeRegion(composed.painted, composed.area.x, composed.area.y);
          }
        });
      }
      session.drawn = composed?.area;
      if (composed !== undefined) {
        session.box = composed.box;
        session.caret = composed.caret;
      }
    }
    this.#status(session);
    this.#show(session);
  }

  /** Re-renders the text when a setting or a font changes, if a text is being edited. */
  #rerender(): void {
    const session = this.#live();
    if (session !== undefined) this.#render(session);
  }

  #optionChanged(change: SettingChange): void {
    if (change.path === "tools.text.fontFamily" || change.path === "tools.text.fontStyle") {
      this.#preloadFace();
    }
    if (change.path === PRIMARY_COLOR_PATH) {
      // Text is drawn with the primary color, live, and its whole edit stays one "Text" step.
      if (this.#live() !== undefined) this.#recolor.request(() => this.#rerender());
      return;
    }
    if (change.path.startsWith("tools.text.") || LIVE_OPTIONS.has(change.path)) this.#rerender();
  }

  /** Starts loading the chosen face, so its files are usually in before the first letter is typed. */
  #preloadFace(): void {
    const settings = this.#host.settings();
    if (settings === null) return;
    const styles = textStyles(settings.get("tools.text.fontStyle"));
    this.#deps.fonts.ensure({
      family: this.#deps.fonts.resolve(settings.get("tools.text.fontFamily")),
      bold: styles.has("Bold"),
      italic: styles.has("Italic"),
    });
  }

  /** Puts the box, the caret and the move handle on the canvas. Ctrl hides the handle and the caret. */
  #show(session: TextSession): void {
    const visible = !session.ctrlHeld;
    const box = session.box;
    textHandles.set({
      ...(box === undefined ? {} : { box }),
      ...(visible && session.caretOn && session.caret !== undefined
        ? { caret: session.caret }
        : {}),
      ...(visible && box !== undefined ? { handle: handleOf(box) } : {}),
    });
  }

  /** The status text: the anchor point and the move hint (TL-TEXT-01). */
  #status(session: TextSession): void {
    const t = this.#host.translate;
    const unit = measureUnit(this.#host.settings()?.get("workspace.measurementUnit"));
    const scale = unitsPerPixel(session.document.resolution, unit);
    const { anchor } = session.block;
    const anchorText = t("tool.status.textAnchor", {
      x: formatMeasure(anchor.x * scale.x, unit),
      y: formatMeasure(anchor.y * scale.y, unit),
      u: unitAbbreviation(unit, t),
    });
    this.#host.status?.(`${anchorText}. ${t("tool.status.textMove")}`);
  }

  /**
   * Ends the session when it is no longer the document's latest state: another document is shown,
   * or an undo or an edit ran. The preview is then left as it is, since the history owns the layer.
   */
  #live(): TextSession | undefined {
    const session = this.#session;
    if (session === undefined) return undefined;
    const document = this.#host.document();
    if (
      document !== session.document ||
      session.document.history.appliedCommands.at(-1) !== session.top
    ) {
      this.#end(session);
      return undefined;
    }
    return session;
  }

  #setCtrl(session: TextSession, held: boolean): void {
    if (session.ctrlHeld === held) return;
    session.ctrlHeld = held;
    this.#show(session);
  }

  /** Records the text as one history item and removes the preview. */
  #finish(session: TextSession): void {
    const options = this.#options(session);
    let composed: Composed | undefined;
    try {
      if (options !== undefined && !session.block.isEmpty) {
        composed = this.#compose(session, options);
      }
    } finally {
      this.#revert(session);
      this.#end(session);
    }
    if (composed === undefined) return;
    const { area, painted } = composed;
    session.document.editLayerPixels(
      this.#host.translate("history.text"),
      session.layer,
      area,
      (pixels) => {
        pixels.writeRegion(painted, area.x, area.y);
      },
    );
  }

  /** Restores the layer region the preview covers from the layer before the text. */
  #revert(session: TextSession): void {
    const drawn = session.drawn;
    if (drawn === undefined) return;
    session.drawn = undefined;
    session.document.restoreLayerPixels(session.layer, (pixels) => {
      session.base.restore(pixels, drawn);
    });
  }

  #end(session: TextSession): void {
    this.#frames.cancel();
    this.#recolor.cancel();
    if (session.timer !== undefined) clearInterval(session.timer);
    session.timer = undefined;
    if (this.#session === session) this.#session = undefined;
    textHandles.set({});
    this.#input?.blur();
    this.#host.status?.(this.#host.translate("tool.help.text"));
  }

  #fail(cause: unknown): void {
    reportToolFailure(this.#host, cause);
  }
}

/** The move handle of a box: its top right corner. */
function handleOf(box: TextBox): TextPoint {
  return { x: box.x + box.width, y: box.y };
}

/**
 * The runtime of the Text tool (TL-TEXT-01). `deps` defaults to the canvas text engine, the app's
 * font catalog and a hidden text input.
 */
export function textToolRuntime(
  host: PaintHost,
  deps: TextToolDeps = browserDeps(host),
): ToolRuntime {
  return new TextRuntime(host, deps);
}
