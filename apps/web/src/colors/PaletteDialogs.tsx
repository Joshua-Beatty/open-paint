import { useTranslation } from "@openpaint/i18n/react";
import { useState } from "react";
import { Button, Form, Input, Label, TextField } from "react-aria-components";
import { ModalDialog } from "../shell/ModalDialog";
import { paletteNameProblem } from "./palette";

export interface PaletteNameDialogProps {
  readonly isOpen: boolean;
  readonly mode: "save" | "rename";
  /** The user palettes that exist. Saving lists them, and a click fills the name. */
  readonly names: readonly string[];
  readonly initialName: string;
  readonly onSubmit: (name: string) => void;
  readonly onClose: () => void;
}

/** Save Current Palette As, or Rename Current Palette (DOC-COL-04). */
export function PaletteNameDialog(props: PaletteNameDialogProps) {
  const t = useTranslation();
  const title = t(
    props.mode === "save" ? "colors.dialog.save.title" : "colors.dialog.rename.title",
  );
  return (
    <ModalDialog isOpen={props.isOpen} onClose={props.onClose} title={title}>
      {props.isOpen && <PaletteNameForm {...props} />}
    </ModalDialog>
  );
}

function PaletteNameForm({
  mode,
  names,
  initialName,
  onSubmit,
  onClose,
}: Omit<PaletteNameDialogProps, "isOpen">) {
  const t = useTranslation();
  const [name, setName] = useState(initialName);
  const [attempted, setAttempted] = useState(false);
  const problem = paletteNameProblem(name);
  const message =
    problem === null || !attempted
      ? undefined
      : t(problem === "empty" ? "colors.dialog.nameEmpty" : "colors.dialog.nameInvalid");
  return (
    <Form
      className="palette-name-form"
      onSubmit={(event) => {
        event.preventDefault();
        setAttempted(true);
        if (paletteNameProblem(name) !== null) return;
        onSubmit(name.trim());
      }}
    >
      <TextField
        className="palette-name-field"
        value={name}
        onChange={setName}
        isInvalid={message !== undefined}
        autoFocus
      >
        <Label>{t("colors.dialog.nameLabel")}</Label>
        <Input />
        {message !== undefined && <span className="palette-name-error">{message}</span>}
      </TextField>
      {mode === "save" && names.length > 0 && (
        <div className="palette-name-list">
          <p className="palette-name-list-heading">{t("colors.dialog.existing")}</p>
          {names.map((existing) => (
            <Button
              key={existing}
              className="palette-name-option"
              aria-pressed={existing === name}
              onPress={() => setName(existing)}
            >
              {existing}
            </Button>
          ))}
        </div>
      )}
      <div className="modal-actions">
        <Button onPress={onClose}>{t("colors.dialog.cancel")}</Button>
        <Button type="submit" className="is-default">
          {t("colors.dialog.ok")}
        </Button>
      </div>
    </Form>
  );
}

export interface ReplaceDialogProps {
  /** The palette name that would be replaced, or null when no answer is awaited. */
  readonly name: string | null;
  readonly onAnswer: (replace: boolean) => void;
}

/** The overwrite confirmation (DOC-COL-04). Cancel leaves both palettes unchanged. */
export function ReplaceDialog({ name, onAnswer }: ReplaceDialogProps) {
  const t = useTranslation();
  return (
    <ModalDialog
      isOpen={name !== null}
      onClose={() => onAnswer(false)}
      title={t("colors.dialog.replace.title")}
    >
      {name !== null && (
        <>
          <p>{t("colors.dialog.replace.text", { name })}</p>
          <div className="modal-actions">
            <Button onPress={() => onAnswer(false)}>{t("colors.dialog.cancel")}</Button>
            <Button className="is-default" onPress={() => onAnswer(true)}>
              {t("colors.dialog.replace.button")}
            </Button>
          </div>
        </>
      )}
    </ModalDialog>
  );
}

export interface DeleteDialogProps {
  readonly isOpen: boolean;
  readonly name: string;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

/** Delete Current Palette, after a confirmation (UI-FTW-06). */
export function DeleteDialog({ isOpen, name, onConfirm, onClose }: DeleteDialogProps) {
  const t = useTranslation();
  return (
    <ModalDialog isOpen={isOpen} onClose={onClose} title={t("colors.dialog.delete.title")}>
      <p>{t("colors.dialog.delete.text", { name })}</p>
      <div className="modal-actions">
        <Button onPress={onClose}>{t("colors.dialog.cancel")}</Button>
        <Button className="is-default" onPress={onConfirm}>
          {t("colors.dialog.delete.button")}
        </Button>
      </div>
    </ModalDialog>
  );
}
