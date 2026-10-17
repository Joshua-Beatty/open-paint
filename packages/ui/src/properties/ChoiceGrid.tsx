import { useTranslation } from "@openpaint/i18n/react";
import type {
  ChoiceGrid,
  ChoiceOption,
  ChoiceProperty,
  PropertyValue,
} from "@openpaint/properties";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  Radio,
  RadioGroup,
  Tooltip,
  type TooltipTriggerState,
  TooltipTriggerStateContext,
} from "react-aria-components";
import { OptionIcon } from "./icons";

/** How long the pointer rests on a cell before its tooltip shows, like the other tooltips. */
const TOOLTIP_DELAY_MS = 500;

/** The track sizes of a grid axis: one per cell, with a gap track after the marked ones. */
function tracks(count: number, gapsAfter: readonly number[]): { template: string; at: number[] } {
  const sizes: string[] = [];
  const at: number[] = [];
  for (let index = 0; index < count; index++) {
    at.push(sizes.length + 1);
    sizes.push("var(--prop-choice-cell, 32px)");
    if (gapsAfter.includes(index) && index < count - 1) sizes.push("var(--prop-choice-gap, 6px)");
  }
  return { template: sizes.join(" "), at };
}

/** The state of an open tooltip that `close` hides. */
function tipState(close: () => void): TooltipTriggerState {
  return { isOpen: true, open: () => {}, close, shouldSkipAnimation: true };
}

/** Whether an element has focus from the keyboard, so a click does not show a tooltip. */
function keyboardFocus(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return false;
  }
}

const MOVES: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
};

/**
 * The nearest cell from (`row`, `column`) in a direction that holds a choosable option, or
 * undefined at the grid's edge. Empty and disabled cells are skipped.
 */
export function nextGridCell(
  grid: ChoiceGrid,
  options: readonly ChoiceOption[],
  row: number,
  column: number,
  [dRow, dColumn]: readonly [number, number],
): { row: number; column: number } | undefined {
  let r = row + dRow;
  let c = column + dColumn;
  while (r >= 0 && r < grid.rows.length && c >= 0 && c < (grid.rows[r]?.length ?? 0)) {
    const value = grid.rows[r]?.[c];
    const option = options.find((candidate) => candidate.value === value);
    if (value !== null && option !== undefined && option.disabled !== true) {
      return { row: r, column: c };
    }
    r += dRow;
    c += dColumn;
  }
  return undefined;
}

/**
 * A choice laid out as a grid of icon buttons (ControlOptions.choiceGrid): one radio group whose
 * cells show the options' icons, are named by their labels and show them as tooltips. The arrow
 * keys move through the grid by row and column.
 */
export function ChoiceGridBody({
  definition,
  grid,
  value,
  readOnly,
  name,
  onChange,
}: {
  readonly definition: ChoiceProperty;
  readonly grid: ChoiceGrid;
  readonly value: PropertyValue;
  readonly readOnly: boolean;
  readonly name: string;
  readonly onChange: (value: PropertyValue) => void;
}) {
  const t = useTranslation();
  const groupRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<Element | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [tip, setTip] = useState<string | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const columns = grid.rows[0]?.length ?? 0;
  const columnTracks = tracks(columns, grid.gapAfterColumns ?? []);
  const rowTracks = tracks(grid.rows.length, grid.gapAfterRows ?? []);
  const optionOf = (cell: PropertyValue | null) =>
    definition.options.find((option) => option.value === cell);

  const showTip = (key: string, anchor: Element, delay: number) => {
    clearTimeout(timer.current);
    anchorRef.current = anchor;
    if (delay === 0) setTip(key);
    else timer.current = setTimeout(() => setTip(key), delay);
  };
  const hideTip = () => {
    clearTimeout(timer.current);
    setTip(undefined);
  };

  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    const move = MOVES[event.key];
    if (move === undefined || readOnly) return;
    let row = -1;
    let column = -1;
    grid.rows.forEach((cells, r) => {
      const c = cells.findIndex((cell) => cell !== null && String(cell) === String(value));
      if (c >= 0) {
        row = r;
        column = c;
      }
    });
    if (row < 0) return;
    event.preventDefault();
    event.stopPropagation();
    const next = nextGridCell(grid, definition.options, row, column, move);
    const option =
      next === undefined ? undefined : optionOf(grid.rows[next.row]?.[next.column] ?? null);
    if (option === undefined) return;
    onChange(option.value);
    const input = groupRef.current?.querySelector<HTMLInputElement>(
      `input[value="${CSS.escape(String(option.value))}"]`,
    );
    input?.focus();
  };

  const tipOption = tip === undefined ? undefined : optionOf(tip);
  return (
    <div ref={groupRef} className="prop-choice-grid-frame" onKeyDownCapture={onKeyDownCapture}>
      <RadioGroup
        aria-label={name}
        className="prop-choice-grid"
        value={String(value)}
        isDisabled={readOnly}
        style={{
          gridTemplateColumns: columnTracks.template,
          gridTemplateRows: rowTracks.template,
        }}
        onChange={(key) => {
          const option = definition.options.find((candidate) => String(candidate.value) === key);
          if (option !== undefined) onChange(option.value);
        }}
        onBlur={hideTip}
      >
        {grid.rows.flatMap((cells, row) =>
          cells.map((cell, column) => {
            const option = optionOf(cell);
            if (option === undefined) return null;
            const key = String(option.value);
            const label = t(option.label);
            return (
              <Radio
                key={key}
                value={key}
                className="prop-choice-cell"
                isDisabled={option.disabled === true}
                style={{ gridColumn: columnTracks.at[column], gridRow: rowTracks.at[row] }}
                onHoverStart={(event) => showTip(key, event.target, TOOLTIP_DELAY_MS)}
                onHoverEnd={hideTip}
                onFocus={(event) => {
                  const target = event.target as Element;
                  const cellElement = target.closest(".prop-choice-cell");
                  if (cellElement !== null && keyboardFocus(target)) showTip(key, cellElement, 0);
                }}
              >
                {option.icon === undefined ? null : <OptionIcon path={option.icon} />}
                <span className="prop-visually-hidden">{label}</span>
              </Radio>
            );
          }),
        )}
      </RadioGroup>
      {tipOption !== undefined && (
        // A standalone tooltip still reads its state from the trigger context to position itself.
        <TooltipTriggerStateContext.Provider value={tipState(hideTip)}>
          <Tooltip className="prop-tooltip" triggerRef={anchorRef} isOpen onOpenChange={hideTip}>
            {t(tipOption.tooltip ?? tipOption.label)}
          </Tooltip>
        </TooltipTriggerStateContext.Provider>
      )}
    </div>
  );
}
