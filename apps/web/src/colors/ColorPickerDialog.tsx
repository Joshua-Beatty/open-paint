import { useTranslation } from "@openpaint/i18n/react";
import { useState } from "react";
import { Button, Form } from "react-aria-components";
import { ModalDialog } from "../shell/ModalDialog";
import { ColorEditor } from "./ColorEditor";
import type { Rgba } from "./color-math";

export interface ColorPickerDialogProps {
  /** The color the dialog starts from, such as a swatch's color. */
  readonly initial: Rgba;
  readonly onOk: (color: Rgba) => void;
  readonly onCancel: () => void;
}

/**
 * The app's color choice in a modal (ADJ-LEVELS-UI-04). It holds the full color editor of the
 * Colors panel, and the caller mounts it only while it is open, so each open starts from `initial`.
 */
export function ColorPickerDialog({ initial, onOk, onCancel }: ColorPickerDialogProps) {
  const t = useTranslation();
  const [color, setColor] = useState(initial);
  return (
    <ModalDialog isOpen onClose={onCancel} title={t("colors.picker.title")}>
      <Form
        className="color-picker-form"
        onSubmit={(event) => {
          event.preventDefault();
          onOk(color);
        }}
      >
        <ColorEditor color={color} onChange={setColor} />
        <div className="modal-actions">
          <Button onPress={onCancel}>{t("dialog.cancel")}</Button>
          <Button type="submit" className="is-default">
            {t("dialog.ok")}
          </Button>
        </div>
      </Form>
    </ModalDialog>
  );
}
