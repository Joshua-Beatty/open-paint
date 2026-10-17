import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from "react";
import { Button, Dialog, DialogTrigger, Popover, Tooltip } from "react-aria-components";
import { STRIP_ITEM_ATTRIBUTE } from "../properties/layout-context";
import { TooltipTrigger } from "../tooltip";
import { firstHidden } from "./overflow-math";
import "./overflow-row.css";

/** Set on a row item that does not fit, which the row hides and the More menu shows instead. */
export const OVERFLOWED_ATTRIBUTE = "data-overflowed";

const ITEM_SELECTOR = `[${STRIP_ITEM_ATTRIBUTE}]`;
/** The More button's width before it has been drawn once: a 28 px button and its margin. */
const MORE_WIDTH_FALLBACK = 34;

export interface OverflowRowProps {
  /** The accessible name and tooltip of the More button. */
  readonly moreLabel: string;
  readonly className?: string;
  /**
   * The row's content. Every element marked with `data-strip-item` is one item; wrappers between
   * them are laid out with `display: contents`, so the items sit in the row as if they were its
   * children. The More menu renders the same content again and shows only the items that did not fit.
   */
  readonly children: ReactNode;
}

function itemsOf(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(ITEM_SELECTOR)];
}

function setOverflowed(item: HTMLElement, overflowed: boolean): void {
  if (overflowed === item.hasAttribute(OVERFLOWED_ATTRIBUTE)) return;
  item.toggleAttribute(OVERFLOWED_ATTRIBUTE, overflowed);
  item.inert = overflowed;
}

/**
 * A single toolbar row that never wraps (the priority+ pattern). Items keep their order; those
 * that do not fit are hidden from the end, and a More button at the end of the row lists them in
 * a popover. The row is measured only when its size or an item's size changes (ResizeObserver),
 * or when items come and go, never per frame (L1).
 */
export function OverflowRow({ moreLabel, className, children }: OverflowRowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreWidth = useRef(MORE_WIDTH_FALLBACK);
  const [hiddenFrom, setHiddenFrom] = useState<number | undefined>(undefined);

  const measure = useCallback(() => {
    const row = rowRef.current;
    const container = itemsRef.current;
    if (row === null || container === null) return;
    const more = moreRef.current;
    if (more !== null) moreWidth.current = more.getBoundingClientRect().width;
    const items = itemsOf(container);
    const gap = Number.parseFloat(getComputedStyle(container).columnGap) || 0;
    const from = firstHidden(
      items.map((item) => item.getBoundingClientRect().width),
      gap,
      row.clientWidth,
      moreWidth.current,
    );
    items.forEach((item, index) => {
      setOverflowed(item, from !== undefined && index >= from);
    });
    setHiddenFrom(from);
  }, []);

  useLayoutEffect(() => {
    const row = rowRef.current;
    const container = itemsRef.current;
    if (row === null || container === null) return;
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const resize = new ResizeObserver(() => measure());
    const observeItems = () => {
      resize.disconnect();
      resize.observe(row);
      for (const item of itemsOf(container)) resize.observe(item);
    };
    observeItems();
    // Items come and go with the tool and its modes; each change re-measures once.
    const mutations = new MutationObserver(() => {
      observeItems();
      measure();
    });
    mutations.observe(container, { childList: true, subtree: true });
    return () => {
      resize.disconnect();
      mutations.disconnect();
    };
  }, [measure]);

  return (
    <div
      ref={rowRef}
      className={className === undefined ? "overflow-row" : `overflow-row ${className}`}
    >
      <div ref={itemsRef} className="overflow-row-items">
        {children}
      </div>
      {hiddenFrom === undefined ? null : (
        <div ref={moreRef} className="overflow-row-more">
          <DialogTrigger>
            <TooltipTrigger delay={500}>
              <Button className="overflow-row-more-button" aria-label={moreLabel}>
                <svg className="overflow-row-more-icon" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" />
                </svg>
              </Button>
              <Tooltip className="prop-tooltip">{moreLabel}</Tooltip>
            </TooltipTrigger>
            <Popover className="overflow-menu-popover" placement="bottom end">
              <Dialog className="overflow-menu" aria-label={moreLabel}>
                <OverflowMenuItems hiddenFrom={hiddenFrom}>{children}</OverflowMenuItems>
              </Dialog>
            </Popover>
          </DialogTrigger>
        </div>
      )}
    </div>
  );
}

/** The More menu's copy of the row content, showing only the items from `hiddenFrom` on. */
function OverflowMenuItems({
  hiddenFrom,
  children,
}: {
  readonly hiddenFrom: number;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = ref.current;
    if (container === null) return;
    const apply = () => {
      itemsOf(container).forEach((item, index) => {
        item.hidden = index < hiddenFrom;
      });
    };
    apply();
    const mutations = new MutationObserver(apply);
    mutations.observe(container, { childList: true, subtree: true });
    return () => mutations.disconnect();
  }, [hiddenFrom]);
  return (
    <div ref={ref} className="overflow-menu-items">
      {children}
    </div>
  );
}
