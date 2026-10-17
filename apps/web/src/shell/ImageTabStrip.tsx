import { useTranslation } from "@openpaint/i18n/react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button, Menu, MenuItem, MenuTrigger, Popover } from "react-aria-components";
import type { BuiltInCommandId } from "../commands/catalog";
import type { ShortcutController } from "../commands/shortcuts";
import {
  dropIndex,
  type OverflowEdges,
  overflowEdges,
  revealScrollLeft,
  type Span,
  slideOffset,
  wheelScrollPx,
} from "../tabs/tab-layout";
import { tabMenuEntries } from "../tabs/tab-menu";
import { MenuList } from "./MenuBar";
import { type BoxSize, thumbnailBox } from "./thumbnail-box";

/** One image as the strip shows it. `thumbnail` is a data URL, undefined until it is drawn. */
export interface ImageTabView {
  readonly id: string;
  readonly title: string;
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly thumbnail: string | undefined;
  /** The image's size in pixels, which the thumbnail box takes its aspect ratio from. */
  readonly size?: BoxSize;
}

/** The largest box a tab thumbnail is shown in, in CSS px (`.app-image-tab-thumb`). */
const TAB_THUMBNAIL_BOX: BoxSize = { width: 40, height: 26 };

/** The largest box an image-list thumbnail is shown in, in CSS px (`.app-image-tab-list-slot`). */
const LIST_THUMBNAIL_BOX: BoxSize = { width: 28, height: 20 };

export interface ImageTabStripProps {
  readonly tabs: readonly ImageTabView[];
  readonly activeId: string | undefined;
  /** Runs the image commands from the tab context menu and reads whether they can run. */
  readonly commands: ShortcutController<BuiltInCommandId>;
  readonly onActivate: (id: string) => void;
  readonly onClose: (id: string) => void;
  /** Puts a dragged tab at `index` in the final order. */
  readonly onMove: (id: string, index: number) => void;
  /** Whether the context menu offers Save As, which repeats Save without file pickers. */
  readonly saveAsOffered?: boolean;
}

/** Movement before a press counts as a drag, in CSS pixels. */
const DRAG_THRESHOLD_PX = 4;
/** Hold-to-scroll timing for the arrow buttons. */
const REPEAT_DELAY_MS = 350;
const REPEAT_INTERVAL_MS = 100;

interface DragGesture {
  readonly id: string;
  readonly pointerId: number;
  readonly startX: number;
  readonly from: number;
  readonly slots: readonly Span[];
  readonly width: number;
  moved: boolean;
  to: number;
}

interface DragView {
  readonly id: string;
  readonly dx: number;
  readonly from: number;
  readonly to: number;
  readonly width: number;
}

interface MenuAnchor {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

function itemElement(scroller: HTMLElement, id: string | undefined): HTMLElement | undefined {
  return Array.from(scroller.querySelectorAll<HTMLElement>("[data-tab-id]")).find(
    (element) => element.dataset.tabId === id,
  );
}

function tabElement(scroller: HTMLElement, id: string | undefined): HTMLElement | undefined {
  return itemElement(scroller, id)?.querySelector<HTMLElement>('[role="tab"]') ?? undefined;
}

function slotsOf(scroller: HTMLElement): Span[] {
  return Array.from(scroller.querySelectorAll<HTMLElement>("[data-tab-id]"), (element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, width: rect.width };
  });
}

function tabTransform(drag: DragView | null, id: string, index: number): string | undefined {
  if (drag === null) return undefined;
  if (drag.id === id) return `translateX(${drag.dx}px)`;
  const shift = slideOffset(index, drag.from, drag.to, drag.width);
  return shift === 0 ? undefined : `translateX(${shift}px)`;
}

/** The index a key moves the selection to, or undefined when the key is not a tab key. */
function keyTarget(key: string, index: number, count: number): number | undefined {
  if (key === "ArrowLeft") return index > 0 ? index - 1 : undefined;
  if (key === "ArrowRight") return index < count - 1 ? index + 1 : undefined;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return undefined;
}

function Chevron({ direction }: { readonly direction: "left" | "right" | "down" }) {
  const d = direction === "down" ? "M2 3.5 L5 6.5 L8 3.5" : "M6.5 2 L3.5 5 L6.5 8";
  const rotate = direction === "right" ? "rotate(180 5 5)" : undefined;
  return (
    <svg aria-hidden="true" viewBox="0 0 10 10" width="10" height="10">
      <path d={d} transform={rotate} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 10 10" width="8" height="8">
      <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/**
 * The image tab strip (UI-TABS). Each tab shows a live thumbnail, a dirty badge and a close
 * button. The strip scrolls with arrows, the wheel and the active tab's reveal, and tabs can be
 * dragged to reorder them. Right-click, and Alt+- for the active tab, open the tab menu.
 */
export function ImageTabStrip({
  tabs,
  activeId,
  commands,
  onActivate,
  onClose,
  onMove,
  saveAsOffered = true,
}: ImageTabStripProps) {
  const t = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const activeRef = useRef(activeId);
  const [edges, setEdges] = useState<OverflowEdges>({
    scrollable: false,
    atStart: true,
    atEnd: true,
  });
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const [drag, setDrag] = useState<DragView | null>(null);
  const gesture = useRef<DragGesture | null>(null);
  const suppressClick = useRef(false);
  const repeat = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    activeRef.current = activeId;
  }, [activeId]);

  const measure = useCallback(() => {
    const element = scroller.current;
    if (element === null) return;
    const next = overflowEdges({
      scrollLeft: element.scrollLeft,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    });
    // An unchanged measure keeps the state, so it does not render the strip again (L3).
    setEdges((previous) =>
      previous.scrollable === next.scrollable &&
      previous.atStart === next.atStart &&
      previous.atEnd === next.atEnd
        ? previous
        : next,
    );
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the tab list changes the scroll range, so every change of tabs measures again
  useLayoutEffect(() => {
    measure();
  }, [measure, tabs]);

  useEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  useEffect(() => {
    const element = scroller.current;
    const tab = element === null ? undefined : itemElement(element, activeId);
    if (element === null || tab === undefined) return;
    const box = element.getBoundingClientRect();
    const rect = tab.getBoundingClientRect();
    element.scrollLeft = revealScrollLeft(
      { scrollLeft: element.scrollLeft, clientWidth: element.clientWidth },
      { left: rect.left - box.left + element.scrollLeft, width: rect.width },
    );
    measure();
  }, [activeId, measure]);

  const stopRepeat = useCallback(() => {
    clearTimeout(repeat.current);
    repeat.current = undefined;
  }, []);

  useEffect(() => stopRepeat, [stopRepeat]);

  const scrollBy = useCallback((direction: -1 | 1) => {
    const element = scroller.current;
    if (element === null) return;
    element.scrollLeft += direction * Math.max(48, Math.round(element.clientWidth / 2));
  }, []);

  const startRepeat = useCallback(
    (direction: -1 | 1) => {
      stopRepeat();
      scrollBy(direction);
      const again = (wait: number) => {
        repeat.current = setTimeout(() => {
          scrollBy(direction);
          again(REPEAT_INTERVAL_MS);
        }, wait);
      };
      again(REPEAT_DELAY_MS);
    },
    [scrollBy, stopRepeat],
  );

  const openActiveMenu = useCallback(() => {
    const element = scroller.current;
    const tab = element === null ? undefined : tabElement(element, activeRef.current);
    const id = activeRef.current;
    if (id === undefined || tab === undefined) return;
    const rect = tab.getBoundingClientRect();
    setAnchor({ id, x: rect.left, y: rect.bottom });
  }, []);

  useEffect(
    () =>
      commands.register("view.tabMenu", {
        run: openActiveMenu,
        enabled: () => activeRef.current !== undefined,
      }),
    [commands, openActiveMenu],
  );

  const onTabPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    id: string,
    index: number,
  ) => {
    const element = scroller.current;
    if (event.button !== 0 || element === null) return;
    suppressClick.current = false;
    const slots = slotsOf(element);
    gesture.current = {
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      from: index,
      slots,
      width: slots[index]?.width ?? 0,
      moved: false,
      to: index,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onTabPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (current === null || event.pointerId !== current.pointerId) return;
    const dx = event.clientX - current.startX;
    if (!current.moved) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      current.moved = true;
    }
    const slot = current.slots[current.from];
    if (slot === undefined) return;
    current.to = dropIndex(current.from, slot.left + slot.width / 2 + dx, current.slots);
    setDrag({ id: current.id, dx, from: current.from, to: current.to, width: current.width });
  };

  const endGesture = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const current = gesture.current;
    if (current === null || event.pointerId !== current.pointerId) return;
    gesture.current = null;
    setDrag(null);
    if (!current.moved) return;
    suppressClick.current = true;
    if (!cancelled && current.to !== current.from) onMove(current.id, current.to);
  };

  const onTabClick = (id: string) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    onActivate(id);
  };

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, id: string, index: number) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onActivate(id);
      return;
    }
    const target = keyTarget(event.key, index, tabs.length);
    const next = target === undefined ? undefined : tabs[target];
    if (next === undefined) return;
    event.preventDefault();
    onActivate(next.id);
    const element = scroller.current;
    if (element !== null) tabElement(element, next.id)?.focus();
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const element = scroller.current;
    if (element === null) return;
    element.scrollLeft += wheelScrollPx(event, element.clientWidth);
  };

  const menuTab = anchor === null ? undefined : tabs.find((tab) => tab.id === anchor.id);

  return (
    <div className="app-image-tab-strip">
      {edges.scrollable && (
        <Button
          aria-label={t("tabs.scrollLeft")}
          className="app-image-tab-arrow"
          isDisabled={edges.atStart}
          onPressStart={() => startRepeat(-1)}
          onPressEnd={stopRepeat}
        >
          <Chevron direction="left" />
        </Button>
      )}
      <div
        ref={scroller}
        role="tablist"
        aria-label={t("tabs.tabList")}
        aria-orientation="horizontal"
        className={`app-image-tab-scroller${edges.atStart ? "" : " is-fade-start"}${
          edges.atEnd ? "" : " is-fade-end"
        }`}
        onScroll={measure}
        onWheel={onWheel}
      >
        {tabs.map((tab, index) => {
          const selected = tab.id === activeId;
          const dragged = drag?.id === tab.id;
          const label = tab.dirty ? t("tabs.dirtyName", { name: tab.title }) : tab.title;
          return (
            <div
              key={tab.id}
              className={`app-image-tab-item${dragged ? " is-dragging" : ""}${
                tab.dirty ? " is-dirty" : ""
              }`}
              data-tab-id={tab.id}
              style={{ transform: tabTransform(drag, tab.id, index) }}
            >
              <div
                role="tab"
                tabIndex={selected || (activeId === undefined && index === 0) ? 0 : -1}
                aria-selected={selected}
                aria-label={label}
                aria-busy={tab.busy || undefined}
                className={`app-image-tab${selected ? " is-active" : ""}`}
                onPointerDown={(event) => onTabPointerDown(event, tab.id, index)}
                onPointerMove={onTabPointerMove}
                onPointerUp={(event) => endGesture(event, false)}
                onPointerCancel={(event) => endGesture(event, true)}
                onClick={() => onTabClick(tab.id)}
                onKeyDown={(event) => onTabKeyDown(event, tab.id, index)}
                onMouseDown={(event) => {
                  if (event.button === 1) event.preventDefault();
                }}
                onAuxClick={(event) => {
                  if (event.button === 1) onClose(tab.id);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setAnchor({ id: tab.id, x: event.clientX, y: event.clientY });
                }}
              >
                <span className="app-image-tab-thumb">
                  <span
                    className="app-image-tab-thumb-image"
                    style={thumbnailBox(tab.size ?? TAB_THUMBNAIL_BOX, TAB_THUMBNAIL_BOX)}
                  >
                    {tab.thumbnail !== undefined && <img src={tab.thumbnail} alt="" />}
                  </span>
                </span>
                <span className="app-image-tab-title">{tab.title}</span>
                {tab.busy && <span className="app-image-tab-spinner" aria-hidden="true" />}
                {tab.dirty && <span className="app-image-tab-dirty" aria-hidden="true" />}
              </div>
              {/* Pointer-only: the focused tab is the active one, so Ctrl+W closes it, and the tab menu has Close. */}
              <button
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                className={`app-image-tab-close${selected ? " is-active" : ""}`}
                onClick={() => onClose(tab.id)}
              >
                <CloseIcon />
              </button>
            </div>
          );
        })}
      </div>
      {edges.scrollable && (
        <Button
          aria-label={t("tabs.scrollRight")}
          className="app-image-tab-arrow"
          isDisabled={edges.atEnd}
          onPressStart={() => startRepeat(1)}
          onPressEnd={stopRepeat}
        >
          <Chevron direction="right" />
        </Button>
      )}
      <MenuTrigger>
        <Button
          aria-label={t("tabs.list")}
          className="app-image-tab-arrow"
          isDisabled={tabs.length === 0}
        >
          <Chevron direction="down" />
        </Button>
        <Popover className="app-popover" placement="bottom end">
          <Menu
            aria-label={t("tabs.list")}
            className="app-menu"
            onAction={(key) => onActivate(String(key))}
          >
            {tabs.map((tab) => (
              <MenuItem
                key={tab.id}
                id={tab.id}
                textValue={tab.title}
                className="app-menu-item app-image-tab-list-item"
              >
                {tab.thumbnail !== undefined && (
                  <span className="app-image-tab-list-slot">
                    <img
                      src={tab.thumbnail}
                      alt=""
                      className="app-image-tab-list-thumb"
                      style={thumbnailBox(tab.size ?? LIST_THUMBNAIL_BOX, LIST_THUMBNAIL_BOX)}
                    />
                  </span>
                )}
                <span className="app-menu-label">{tab.title}</span>
              </MenuItem>
            ))}
          </Menu>
        </Popover>
      </MenuTrigger>
      {anchor !== null && menuTab !== undefined && (
        <MenuTrigger
          isOpen
          onOpenChange={(open) => {
            if (!open) setAnchor(null);
          }}
        >
          <Button
            aria-hidden="true"
            aria-label={menuTab.title}
            className="app-image-tab-menu-anchor"
            style={{ left: anchor.x, top: anchor.y }}
          />
          <Popover className="app-popover" placement="bottom start">
            <MenuList
              label={menuTab.title}
              entries={tabMenuEntries(menuTab.title, commands, t, saveAsOffered)}
              actions={{
                onCommand: (command) => {
                  onActivate(anchor.id);
                  commands.invoke(command);
                },
              }}
              autoFocus="first"
            />
          </Popover>
        </MenuTrigger>
      )}
    </div>
  );
}
