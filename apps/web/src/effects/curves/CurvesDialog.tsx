import {
  type CurveMode,
  type CurvePoint,
  type CurvesParams,
  curvesParams,
  curvesValues,
} from "@openpaint/effects";
import { useTranslation } from "@openpaint/i18n/react";
import { useEffect, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Form,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
} from "react-aria-components";
import { ModalDialog } from "../../shell/ModalDialog";
import { FrameCoalescer } from "../../tools/frame-coalescer";
import type { CustomDialogProps } from "../custom-dialog-types";
import { CurvesPlot } from "./CurvesPlot";
import {
  type ChannelDrag,
  type CurveEditState,
  type CurveKey,
  dragCurves,
  editableKeys,
  hoverPoint,
  pressCurves,
  removePoints,
  resetMode,
} from "./curves-model";
import "./curves-dialog.css";

/** The RGB checkboxes, in order, with their labels (ADJ-CURVES-UI-03). */
const RGB_CHANNELS = [
  ["red", "curves.channel.red"],
  ["green", "curves.channel.green"],
  ["blue", "curves.channel.blue"],
] as const;

/**
 * The Curves dialog (ADJ-CURVES-UI): a custom editor for the transfer curves, with a live preview
 * of every change. The mode drop-down, the curve editor, the channel checkboxes and Reset sit in the
 * layout of ADJ-CURVES-UI-01. The stored values hold only the active mode's curves.
 */
export function CurvesDialog({ values, onValuesChange, onOk, onCancel }: CustomDialogProps) {
  const t = useTranslation();
  const [state, setState] = useState<CurveEditState>(() => editStateOf(curvesParams(values)));
  const [pointer, setPointer] = useState<CurvePoint | undefined>(undefined);
  const latest = useRef(state);
  const drag = useRef<readonly ChannelDrag[] | undefined>(undefined);
  const lastDrag = useRef<string | undefined>(undefined);

  const commit = (next: CurveEditState) => {
    latest.current = next;
    setState(next);
    onValuesChange(curvesValues(paramsOf(next)));
  };

  const keys = editableKeys(state);
  const hover =
    pointer === undefined ? undefined : hoverPoint(state.lists, keys, pointer[0], pointer[1]);

  const press = (point: CurvePoint) => {
    const current = latest.current;
    const active = editableKeys(current);
    if (active.length === 0) return;
    moves.current?.cancel();
    const result = pressCurves(current.lists, active, point[0], point[1]);
    drag.current = result.drag;
    lastDrag.current = point.join();
    commit({ ...current, lists: result.lists });
  };

  // Pointer moves are applied once per frame at the newest position (L1), so a drag re-renders the
  // dialog and previews once per frame however fast the pointer reports.
  const moves = useRef<FrameCoalescer | undefined>(undefined);
  moves.current ??= new FrameCoalescer((callback) => {
    const id = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(id);
  });
  useEffect(() => () => moves.current?.cancel(), []);

  const applyMove = (point: CurvePoint) => {
    setPointer((previous) =>
      previous?.[0] === point[0] && previous[1] === point[1] ? previous : point,
    );
    const active = drag.current;
    if (active === undefined) return;
    // A move within the same curve level changes nothing.
    if (active.every((channel) => channel.x === point[0]) && lastDrag.current === point.join()) {
      return;
    }
    lastDrag.current = point.join();
    const current = latest.current;
    const result = dragCurves(current.lists, active, point[0], point[1]);
    drag.current = result.drag;
    commit({ ...current, lists: result.lists });
  };

  const move = (point: CurvePoint) => moves.current?.request(() => applyMove(point));

  const release = () => {
    moves.current?.flush();
    drag.current = undefined;
  };

  const leave = () => {
    if (drag.current === undefined) setPointer(undefined);
  };

  const remove = (point: CurvePoint) => {
    const current = latest.current;
    const lists = removePoints(current.lists, editableKeys(current), point[0], point[1]);
    commit({ ...current, lists });
  };

  const changeMode = (mode: CurveMode) => {
    drag.current = undefined;
    commit({ ...latest.current, mode });
  };

  const setChecked = (key: "red" | "green" | "blue", selected: boolean) => {
    const current = latest.current;
    commit({ ...current, checked: { ...current.checked, [key]: selected } });
  };

  const reset = () => {
    const current = latest.current;
    commit({ ...current, lists: resetMode(current.lists, current.mode) });
  };

  const readout =
    pointer === undefined ? "" : t("curves.readout", { x: pointer[0], y: pointer[1] });

  return (
    <ModalDialog isOpen title={t("curves.dialog.title")} onClose={onCancel} backdrop="clear">
      <Form
        className="curves-form"
        onSubmit={(event) => {
          event.preventDefault();
          onOk(curvesValues(paramsOf(latest.current)));
        }}
      >
        <div className="curves-mode-row">
          <h3 className="curves-heading">{t("curves.group.transferMap")}</h3>
          <Select
            className="curves-mode"
            aria-label={t("curves.group.transferMap")}
            selectedKey={state.mode}
            onSelectionChange={(key) => {
              if (key === "luminosity" || key === "rgb") changeMode(key);
            }}
          >
            <Button className="react-aria-Button curves-button">
              <SelectValue />
            </Button>
            <Popover>
              <ListBox>
                <ListBoxItem id="luminosity" textValue={t("curves.mode.luminosity")}>
                  {t("curves.mode.luminosity")}
                </ListBoxItem>
                <ListBoxItem id="rgb" textValue={t("curves.mode.rgb")}>
                  {t("curves.mode.rgb")}
                </ListBoxItem>
              </ListBox>
            </Popover>
          </Select>
        </div>
        <CurvesPlot
          state={state}
          hover={hover}
          pointer={pointer}
          onPress={press}
          onMove={move}
          onRelease={release}
          onRemove={remove}
          onLeave={leave}
        />
        <div className="curves-channels">
          {state.mode === "luminosity" ? (
            <Checkbox isSelected isDisabled>
              {t("curves.channel.luminosity")}
            </Checkbox>
          ) : (
            RGB_CHANNELS.map(([key, label]) => (
              <Checkbox
                key={key}
                isSelected={state.checked[key]}
                onChange={(selected) => setChecked(key, selected)}
              >
                {t(label)}
              </Checkbox>
            ))
          )}
        </div>
        <p className="curves-readout">{readout}</p>
        <p className="curves-tip">{t("curves.tip.remove")}</p>
        <div className="curves-footer">
          <Button className="react-aria-Button curves-button" onPress={reset}>
            {t("curves.button.reset")}
          </Button>
          <Button className="react-aria-Button curves-button" onPress={onCancel}>
            {t("dialog.cancel")}
          </Button>
          <Button type="submit" className="react-aria-Button curves-button is-default" autoFocus>
            {t("dialog.ok")}
          </Button>
        </div>
      </Form>
    </ModalDialog>
  );
}

/** The dialog's starting state: the stored mode and curves, with every RGB channel checked. */
function editStateOf(params: CurvesParams): CurveEditState {
  return {
    mode: params.mode,
    lists: {
      luminosity: params.luminosity,
      red: params.red,
      green: params.green,
      blue: params.blue,
    },
    checked: { red: true, green: true, blue: true },
  };
}

function paramsOf(state: CurveEditState): CurvesParams {
  const lists: Readonly<Record<CurveKey, CurvesParams["red"]>> = state.lists;
  return {
    mode: state.mode,
    luminosity: lists.luminosity,
    red: lists.red,
    green: lists.green,
    blue: lists.blue,
  };
}
