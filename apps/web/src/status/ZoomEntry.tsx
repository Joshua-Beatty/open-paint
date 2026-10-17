import { ZOOM_PRESETS } from "@openpaint/engine";
import { useTranslation } from "@openpaint/i18n/react";
import { useEffect, useId, useRef, useState } from "react";
import { parseZoomEntry, zoomPercent } from "./status-model";

export interface ZoomEntryProps {
  /** The current zoom in percent, which fills the box selected (UI-SB-03). */
  readonly percent: number;
  /** Receives the zoom ratio after a valid entry (Enter). */
  readonly onApply: (ratio: number) => void;
  /** Closes the box without a change (Esc, or a click elsewhere). */
  readonly onCancel: () => void;
}

/**
 * The borderless zoom box that opens over the zoom amount button (UI-SB-03). Enter applies a valid
 * value. An invalid value shows an error cue and keeps the box open. Esc, or leaving the box, closes
 * it without a change. The presets (UI-VIEW-01) are offered as suggestions.
 */
export function ZoomEntry({ percent, onApply, onCancel }: ZoomEntryProps) {
  const t = useTranslation();
  const [text, setText] = useState(String(percent));
  const [invalid, setInvalid] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const submit = () => {
    const ratio = parseZoomEntry(text);
    if (ratio === undefined) {
      setInvalid(true);
      return;
    }
    onApply(ratio);
  };

  return (
    <>
      <input
        ref={input}
        type="text"
        className={invalid ? "app-zoom-entry app-zoom-entry-invalid" : "app-zoom-entry"}
        aria-label={t("status.zoomEntry")}
        aria-invalid={invalid}
        list={listId}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setInvalid(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        onBlur={onCancel}
      />
      <datalist id={listId}>
        {ZOOM_PRESETS.map((preset) => (
          <option key={preset} value={`${zoomPercent(preset)}%`} />
        ))}
      </datalist>
    </>
  );
}
