import type { MessageId } from "@openpaint/i18n";
import type { PropertySchema } from "@openpaint/properties";
import type { IconId } from "./common";
import type { HostServices } from "./services";

/** A pointer sample delivered to a tool runtime (WEB-PTR-01). Coordinates are canvas pixels. */
export interface ToolPointerEvent {
  readonly type: "down" | "move" | "up" | "cancel";
  readonly x: number;
  readonly y: number;
  /** 0 is the primary button, 2 the secondary one. */
  readonly button: number;
  readonly pressure: number;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  /** A preview-only sample from the predicted events of a move (WEB-PTR-01). Never commit it. */
  readonly predicted?: boolean;
  /**
   * The position in CSS pixels, in client coordinates. Screen-space thresholds use it, such as
   * the click dead zone, so they do not depend on the zoom. Absent from synthetic samples.
   */
  readonly clientX?: number;
  readonly clientY?: number;
  /**
   * The view's zoom as CSS pixels per canvas pixel, so a tool can hit-test its handles in screen
   * space (TL-FRAME-06). Absent from synthetic samples, which count as 100 %.
   */
  readonly viewScale?: number;
}

/** The view state a tool's cursor depends on (TL-ZOOM-01, TL-PAN-01, TL-FRAME-06). */
export interface ToolViewState {
  /** Whether the image is larger than the viewport, so the view can scroll. */
  readonly canPan: boolean;
  /** Whether the view is being dragged: a middle-button or Space drag, or a left drag of the Pan tool. */
  readonly panning: boolean;
  /** The modifier keys held now, which some tools show in their cursor (TL-BRUSH-CS-01, TL-PICK-01). */
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
}

/** The pointer logic of a tool (TL-FRAME-07). */
export interface ToolRuntime {
  activate(): void;
  deactivate(): void;
  pointer(event: ToolPointerEvent): void;
  /**
   * The CSS cursor the tool shows over the canvas for a view state (TL-ZOOM-01, TL-PAN-01), from
   * the last pointer sample it received. Undefined keeps the default cursor, or shows the closed
   * hand while the view is panning.
   */
  cursor?(view: ToolViewState): string | undefined;
  /** Whether a left-button drag pans the view rather than reaching the tool (TL-PAN-01). */
  readonly panOnDrag?: boolean;
  /** Whether a result is drawn but not committed: Dirty or Editing (TL-FRAME-01). */
  hasPending?(): boolean;
  /** Commits the pending result. Present only for commit-capable tools (TL-FRAME-01). */
  commit?(): void;
  /**
   * While the tool is still computing a result it has committed to record, such as a gradient
   * rendered in workers, a promise that settles once it is recorded. The host holds pointer input
   * for every tool until then, so nothing is drawn over a result that is not in the history yet.
   */
  settling?(): Promise<void> | undefined;
  /** A Ctrl press and release with no other input (TL-LINE-01 "Tap Ctrl to toggle handles"). */
  tapCtrl?(): void;
  /** Cancels the drawing in progress (TL-FRAME-01, Enter and Esc while Drawing). */
  cancel?(): void;
  /**
   * Moves what the tool holds by an arrow key: (dx, dy) is the key's direction and `step` the distance
   * in image pixels (1, 10 with Ctrl, 50 with Shift; TL-MOVE-01). Returns whether the tool used the key.
   */
  nudge?(dx: number, dy: number, step: number): boolean;
  /** Whether the tool takes pasted text right now, such as the Text tool while it edits (UI-MENU-EDIT). */
  acceptsPaste?(): boolean;
  /** Takes pasted plain text. Called only when `acceptsPaste` holds. */
  paste?(text: string): void;
}

/** What the host gives a tool runtime. */
export interface ToolHost {
  readonly services: HostServices;
}

/**
 * A tool in the Tools panel (TL-FRAME-07). Its options bar is generated from `options`. A built-in
 * whose runtime the engine binds by `id` omits `createRuntime`.
 */
export interface ToolDescriptor {
  readonly id: string;
  /** The major API version this descriptor targets (EXT-02-13). */
  readonly apiVersion: number;
  readonly label: MessageId;
  /** The status-bar help shown when the tool is activated (TL-FRAME-05). */
  readonly help: MessageId;
  readonly icon: IconId;
  /** A single letter (TL-HOTKEY-01). Several tools may share one, for example O. */
  readonly hotkey: string;
  /** Pressing the hotkey while the tool is active does nothing (TL-HOTKEY-01). */
  readonly skipIfActive: boolean;
  readonly commitCapable: boolean;
  readonly options: PropertySchema;
  readonly createRuntime?: (host: ToolHost) => ToolRuntime;
}
