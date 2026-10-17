import { type Document, type Layer, ThumbnailRenderer } from "@openpaint/document";
import type { MessageId, Translate } from "@openpaint/i18n";
import { useTranslation } from "@openpaint/i18n/react";
import { Icon, TooltipTrigger } from "@openpaint/ui";
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { Button, Checkbox, type PressEvent, Toolbar, Tooltip } from "react-aria-components";
import type { BuiltInCommandId } from "../commands/catalog";
import type { ShortcutController } from "../commands/shortcuts";
import { PHOSPHOR } from "../icons/icon-set";
import { thumbnailBox } from "../shell/thumbnail-box";
import { cachedDataUrl, TAB_THUMBNAIL_INTERVAL_MS } from "../tabs/thumbnail-url";
import { yieldWhileBusy } from "../workers/yield-to-host";
import { setLayerVisible } from "./layer-commands";
import {
  DRAG_THRESHOLD,
  dragTargetIndex,
  LAYER_THUMBNAIL_BOX,
  LAYER_THUMBNAIL_SIZE,
  rowShift,
} from "./layer-list";
import { LayerThumbnails } from "./layer-thumbnails";
import { useDocumentRevision } from "./use-document-revision";

interface ToolbarButton {
  readonly id: BuiltInCommandId;
  /** The 16 px icon, from the app's icon set. */
  readonly icon: string;
  /** The button's accessible name, which the tooltip starts with. */
  readonly name: MessageId;
  /** Ctrl+click runs this command instead (UI-FTW-05). */
  readonly ctrl?: { readonly id: BuiltInCommandId; readonly name: MessageId };
}

/** The bottom toolbar of the Layers panel, in UI-FTW-05 order. */
const TOOLBAR: readonly ToolbarButton[] = [
  { id: "layers.add", icon: PHOSPHOR.plus, name: "command.layers.add" },
  { id: "layers.delete", icon: PHOSPHOR.trash, name: "command.layers.delete" },
  { id: "layers.duplicate", icon: PHOSPHOR.copy, name: "command.layers.duplicate" },
  { id: "layers.mergeDown", icon: PHOSPHOR.arrowsMerge, name: "command.layers.mergeDown" },
  {
    id: "layers.moveUp",
    icon: PHOSPHOR.arrowUp,
    name: "command.layers.moveUp",
    ctrl: { id: "layers.moveTop", name: "command.layers.moveTop" },
  },
  {
    id: "layers.moveDown",
    icon: PHOSPHOR.arrowDown,
    name: "command.layers.moveDown",
    ctrl: { id: "layers.moveBottom", name: "command.layers.moveBottom" },
  },
  { id: "layers.properties", icon: PHOSPHOR.slidersHorizontal, name: "command.layers.properties" },
];

interface DragState {
  readonly id: number;
  /** The layer's index when the drag started. */
  readonly from: number;
  readonly startY: number;
  /** The pointer's vertical travel in CSS px, positive when down. */
  readonly dy: number;
  readonly moved: boolean;
}

/** Layer thumbnails, kept per tile so a refresh reads only what changed (L8). */
const layerThumbnails = new ThumbnailRenderer(LAYER_THUMBNAIL_SIZE);

/** The layer thumbnails, renewed on every change of the shown document (UI-FTW-05). */
function useLayerThumbnails(
  doc: Document | undefined,
  busy: (() => boolean) | undefined,
): LayerThumbnails {
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const [thumbnails] = useState(() => {
    const busy = () => busyRef.current?.() === true;
    const pause = yieldWhileBusy(busy);
    return new LayerThumbnails({
      render: async (layer) => cachedDataUrl(await layerThumbnails.layer(layer, pause)),
      onChange: refresh,
      intervalMs: TAB_THUMBNAIL_INTERVAL_MS,
      busy,
    });
  });
  useEffect(() => {
    thumbnails.show(doc);
    if (doc === undefined) return undefined;
    return doc.subscribe((change) => {
      if (change !== "selection") thumbnails.show(doc);
    });
  }, [doc, thumbnails]);
  useEffect(() => () => thumbnails.dispose(), [thumbnails]);
  return thumbnails;
}

/** The tooltip of a toolbar button: its name, then its shortcut or its Ctrl+click action. */
function tooltipFor(
  t: Translate,
  button: ToolbarButton,
  labels: { readonly shortcuts: readonly string[]; readonly alternates: readonly string[] },
): string {
  const name = t(button.name);
  if (button.ctrl !== undefined) {
    return t("layers.tip.ctrlClick", { name, other: t(button.ctrl.name) });
  }
  const shortcut = labels.shortcuts[0] ?? "";
  const alternate = labels.alternates[0];
  const keys =
    alternate === undefined ? shortcut : t("layers.shortcut.alt", { shortcut, alternate });
  return t("layers.tip.shortcut", { name, shortcut: keys });
}

export interface LayersPanelProps {
  /** The active image, or undefined when none is open. */
  readonly doc: Document | undefined;
  readonly commands: ShortcutController<BuiltInCommandId>;
  /** Whether hiding a layer makes the nearest visible layer active (DOC-LYR-05o). */
  readonly autoSelectNearest: () => boolean;
  /** True while thumbnails should wait: a drag on the canvas or an effect render (L8). */
  readonly thumbnailsBusy?: () => boolean;
}

/**
 * The Layers panel (UI-FTW-05): the layers top first, each with a live thumbnail, its name and a
 * visibility checkbox. A click makes a layer active, a double-click opens Layer Properties, and a
 * drag reorders the layers as one "Move Layer" history item. The toolbar runs the same layer
 * commands as the menus and shortcuts.
 */
export function LayersPanel({
  doc,
  commands,
  autoSelectNearest,
  thumbnailsBusy,
}: LayersPanelProps) {
  const t = useTranslation();
  useDocumentRevision(doc);
  const thumbnails = useLayerThumbnails(doc, thumbnailsBusy);
  const listRef = useRef<HTMLUListElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const dragging = drag !== null;
  const layers = doc?.layers ?? [];
  const rows = [...layers].reverse();
  const activeId = doc?.activeLayer?.id;
  const thumbBox = thumbnailBox(doc ?? LAYER_THUMBNAIL_BOX, LAYER_THUMBNAIL_BOX);

  useEffect(() => {
    if (!dragging || doc === undefined) return undefined;
    const onMove = (event: PointerEvent) => {
      const current = dragRef.current;
      if (current === null) return;
      const dy = event.clientY - current.startY;
      const next = { ...current, dy, moved: current.moved || Math.abs(dy) >= DRAG_THRESHOLD };
      dragRef.current = next;
      setDrag(next);
    };
    const onEnd = () => {
      const current = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (current === null || !current.moved) return;
      const target = dragTargetIndex(current.from, doc.layers.length, current.dy);
      const layer = doc.layers[current.from];
      if (layer === undefined || target === current.from) return;
      doc.setActiveLayer(layer);
      doc.moveActiveLayerTo(target);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
  }, [dragging, doc]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-layer-id="${activeId}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  /** The vertical offset of a row while a drag is under way (UI-FTW-05 reorder animation). */
  const offsetOf = (layer: Layer, index: number): number => {
    if (drag === null) return 0;
    if (drag.id === layer.id) return drag.moved ? drag.dy : 0;
    if (!drag.moved) return 0;
    return rowShift(index, drag.from, dragTargetIndex(drag.from, layers.length, drag.dy));
  };

  const beginDrag = (event: ReactPointerEvent<HTMLLIElement>, layer: Layer, index: number) => {
    if (event.button !== 0 || isOnVisibility(event.target)) return;
    const next = { id: layer.id, from: index, startY: event.clientY, dy: 0, moved: false };
    dragRef.current = next;
    setDrag(next);
  };

  const openProperties = (event: ReactMouseEvent<HTMLLIElement>, layer: Layer) => {
    if (doc === undefined || isOnVisibility(event.target)) return;
    doc.setActiveLayer(layer);
    commands.invoke("layers.properties");
  };

  const runToolbar = (button: ToolbarButton, event: PressEvent) => {
    const id = button.ctrl !== undefined && event.ctrlKey ? button.ctrl.id : button.id;
    commands.invoke(id);
  };

  return (
    <div className="app-layers">
      {doc === undefined ? (
        <p className="app-layers-empty">{t("layers.empty")}</p>
      ) : (
        <ul ref={listRef} className="app-layers-list">
          {rows.map((layer, rowIndex) => {
            const index = layers.length - 1 - rowIndex;
            const offset = offsetOf(layer, index);
            const isDragged = drag !== null && drag.id === layer.id && drag.moved;
            const url = thumbnails.url(layer.id);
            return (
              <li
                key={layer.id}
                data-layer-id={layer.id}
                aria-current={layer.id === activeId ? "true" : undefined}
                className={isDragged ? "app-layer-row is-dragging" : "app-layer-row"}
                style={offset === 0 ? undefined : { transform: `translateY(${offset}px)` }}
                onPointerDownCapture={(event) => beginDrag(event, layer, index)}
                onDoubleClick={(event) => openProperties(event, layer)}
              >
                <Checkbox
                  className="app-layer-visible"
                  isSelected={layer.visible}
                  aria-label={t("layers.visibleFor", { name: layer.name })}
                  onChange={(visible) => {
                    if (doc !== undefined)
                      setLayerVisible(doc, layer, visible, autoSelectNearest());
                  }}
                >
                  <span className="app-layer-check" aria-hidden="true" />
                </Checkbox>
                <Button className="app-layer-select" onPress={() => doc?.setActiveLayer(layer)}>
                  <span className="app-layer-thumb">
                    <span className="app-layer-thumb-image" style={thumbBox}>
                      {url !== undefined && <img src={url} alt="" />}
                    </span>
                  </span>
                  <span className="app-layer-name">{layer.name}</span>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <Toolbar aria-label={t("layers.toolbar")} className="app-layer-toolbar">
        {TOOLBAR.map((button) => {
          const labels = commands.labels(button.id);
          return (
            <TooltipTrigger key={button.id} delay={500}>
              <Button
                className="app-panel-tool"
                aria-label={t(button.name)}
                isDisabled={!commands.isEnabled(button.id)}
                onPress={(event) => runToolbar(button, event)}
              >
                <Icon icon={button.icon} className="app-panel-tool-icon" />
              </Button>
              <Tooltip className="app-tooltip">{tooltipFor(t, button, labels)}</Tooltip>
            </TooltipTrigger>
          );
        })}
      </Toolbar>
    </div>
  );
}

/** Whether an event came from the visibility checkbox, which must not start a drag or open properties. */
function isOnVisibility(target: EventTarget): boolean {
  return target instanceof Element && target.closest(".app-layer-visible") !== null;
}
