import { useTranslation } from "@openpaint/i18n/react";
import { useState, useSyncExternalStore } from "react";
import { Button, Input, Label, Radio, RadioGroup, TextField } from "react-aria-components";
import type { PrintMode } from "../print/print-job";
import { AccessLabel } from "../shell/MenuBar";
import { ModalDialog } from "../shell/ModalDialog";
import { nameForType, typeForName } from "./file-choices";
import type {
  FileDialogRequest,
  FileDialogs,
  SaveTypeChoice,
  TransferChoice,
} from "./file-dialogs";
import { SaveConfigurationDialog } from "./SaveConfigurationDialog";
import "./files.css";

type Request<K extends FileDialogRequest["kind"]> = Extract<FileDialogRequest, { kind: K }>;

export interface FileDialogHostProps {
  readonly dialogs: FileDialogs;
}

/** Draws the file dialog that is on screen: the save prompts, the transfer progress and errors. */
export function FileDialogHost({ dialogs }: FileDialogHostProps) {
  const request = useSyncExternalStore(dialogs.subscribe, () => dialogs.request);
  if (request === undefined) return null;
  switch (request.kind) {
    case "flatten":
      return <FlattenDialog answer={request.answer} />;
    case "recoverLayers":
      return <RecoverLayersDialog answer={request.answer} />;
    case "dropChoice":
      return (
        <DropDialog count={request.count} hasImage={request.hasImage} answer={request.answer} />
      );
    case "importSize":
      return <ImportSizeDialog answer={request.answer} />;
    case "saveName":
      return (
        <SaveNameDialog
          name={request.name}
          types={request.types}
          typeId={request.typeId}
          answer={request.answer}
        />
      );
    case "saving":
      return <SavingDialog />;
    case "print":
      return <PrintDialog answer={request.answer} />;
    case "saveConfig":
      return (
        <SaveConfigurationDialog
          type={request.type}
          codec={request.codec}
          file={request.file}
          values={request.values}
          answer={request.answer}
        />
      );
    case "transfer":
      return (
        <TransferDialog
          index={request.index}
          total={request.total}
          canceling={request.canceling}
          cancel={request.cancel}
        />
      );
    case "transferError":
      return <TransferErrorDialog message={request.message} answer={request.answer} />;
  }
}

/** FMT-SAVE-02: a multi-layer image saved to a flat format is flattened first. */
function FlattenDialog({ answer }: { readonly answer: Request<"flatten">["answer"] }) {
  const t = useTranslation();
  return (
    <ModalDialog isOpen onClose={() => answer(false)} title={t("file.flatten.title")}>
      <p>{t("file.flatten.text")}</p>
      <div className="file-choice">
        <Button className="is-default" onPress={() => answer(true)}>
          <AccessLabel text={t("file.flatten.flatten")} />
        </Button>
        <p>{t("file.flatten.flattenHelp")}</p>
      </div>
      <div className="file-choice">
        <Button onPress={() => answer(false)}>{t("dialog.cancel")}</Button>
        <p>{t("file.flatten.cancelHelp")}</p>
      </div>
    </ModalDialog>
  );
}

/** FMT-NAT-09: a layered file with unreadable layers opens them blank only when the user agrees. */
function RecoverLayersDialog({ answer }: { readonly answer: Request<"recoverLayers">["answer"] }) {
  const t = useTranslation();
  return (
    <ModalDialog isOpen onClose={() => answer(false)} title={t("file.recover.title")}>
      <p>{t("file.recover.text")}</p>
      <div className="file-choice">
        <Button className="is-default" onPress={() => answer(true)}>
          {t("file.recover.open")}
        </Button>
      </div>
      <div className="file-choice">
        <Button onPress={() => answer(false)}>{t("dialog.cancel")}</Button>
      </div>
    </ModalDialog>
  );
}

/** UI-DOC-02: dropped files open as tabs, or are added as layers of the current image. */
function DropDialog({
  count,
  hasImage,
  answer,
}: {
  readonly count: number;
  readonly hasImage: boolean;
  readonly answer: Request<"dropChoice">["answer"];
}) {
  const t = useTranslation();
  const many = count > 1;
  const addHelp = !hasImage
    ? "drop.addLayerNewImage"
    : many
      ? "drop.addLayerMany"
      : "drop.addLayerOne";
  return (
    <ModalDialog isOpen onClose={() => answer(undefined)} title={t("drop.title")}>
      <p>{t(many ? "drop.questionMany" : "drop.questionOne")}</p>
      <div className="file-choice">
        <Button className="is-default" onPress={() => answer("open")}>
          <AccessLabel text={t("drop.open")} />
        </Button>
        <p>{t(many ? "drop.openMany" : "drop.openOne")}</p>
      </div>
      <div className="file-choice">
        <Button onPress={() => answer("addLayers")}>
          <AccessLabel text={t(many ? "drop.addLayers" : "drop.addLayer")} />
        </Button>
        <p>{t(addHelp)}</p>
      </div>
      <div className="modal-actions">
        <Button onPress={() => answer(undefined)}>{t("dialog.cancel")}</Button>
      </div>
    </ModalDialog>
  );
}

/** DOC-LYR-05e: an imported image larger than the canvas. The choices are the paste prompt's. */
function ImportSizeDialog({ answer }: { readonly answer: Request<"importSize">["answer"] }) {
  const t = useTranslation();
  return (
    <ModalDialog isOpen onClose={() => answer("cancel")} title={t("import.title")}>
      <p>{t("import.larger")}</p>
      <div className="modal-actions">
        <Button
          className="is-default"
          aria-description={t("paste.expandHelp")}
          onPress={() => answer("expand")}
        >
          {t("paste.expand")}
        </Button>
        <Button aria-description={t("paste.keepHelp")} onPress={() => answer("keep")}>
          {t("paste.keep")}
        </Button>
        <Button onPress={() => answer("cancel")}>{t("dialog.cancel")}</Button>
      </div>
    </ModalDialog>
  );
}

/** The download Save As: the browser saves the file, so the app asks for the name and type. */
function SaveNameDialog({
  name: initialName,
  types,
  typeId: initialTypeId,
  answer,
}: {
  readonly name: string;
  readonly types: readonly SaveTypeChoice[];
  readonly typeId: string;
  readonly answer: Request<"saveName">["answer"];
}) {
  const t = useTranslation();
  const [name, setName] = useState(initialName);
  const [typeId, setTypeId] = useState(initialTypeId);
  // The name's extension and the Type list follow each other, so what Save writes is never in doubt.
  const changeName = (next: string) => {
    setName(next);
    const owner = typeForName(next, types);
    if (owner !== undefined) setTypeId(owner.id);
  };
  const changeType = (id: string) => {
    setTypeId(id);
    const type = types.find((candidate) => candidate.id === id);
    if (type !== undefined) setName((current) => nameForType(current, types, type));
  };
  return (
    <ModalDialog isOpen onClose={() => answer(undefined)} title={t("file.saveAs.title")}>
      <form
        className="file-save-form"
        onSubmit={(event) => {
          event.preventDefault();
          answer({ name, typeId });
        }}
      >
        <TextField className="file-field" value={name} onChange={changeName} autoFocus>
          <Label>{t("file.saveAs.name")}</Label>
          <Input />
        </TextField>
        <label className="file-field">
          <span>{t("file.saveAs.type")}</span>
          <select value={typeId} onChange={(event) => changeType(event.target.value)}>
            {types.map((type) => (
              <option key={type.id} value={type.id}>
                {type.label}
              </option>
            ))}
          </select>
        </label>
        <div className="modal-actions">
          <Button onPress={() => answer(undefined)}>{t("dialog.cancel")}</Button>
          <Button type="submit" className="is-default">
            {t("file.saveAs.save")}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

function SavingDialog() {
  const t = useTranslation();
  return (
    <ModalDialog isOpen onClose={() => undefined} title={t("file.saving.title")} closable={false}>
      <p role="status" aria-live="polite">
        {t("file.saving.text")}
      </p>
    </ModalDialog>
  );
}

/** FMT-PRN-01: fit the image to the page (the default), or print it at its real size. */
function PrintDialog({ answer }: { readonly answer: Request<"print">["answer"] }) {
  const t = useTranslation();
  const [mode, setMode] = useState<PrintMode>("fit");
  return (
    <ModalDialog isOpen onClose={() => answer(undefined)} title={t("print.title")}>
      <form
        className="file-save-form"
        onSubmit={(event) => {
          event.preventDefault();
          answer(mode);
        }}
      >
        <RadioGroup
          aria-label={t("print.size")}
          value={mode}
          onChange={(value) => setMode(value === "actual" ? "actual" : "fit")}
        >
          <div className="file-choice">
            <Radio value="fit">{t("print.fit")}</Radio>
            <p>{t("print.fitHelp")}</p>
          </div>
          <div className="file-choice">
            <Radio value="actual">{t("print.actual")}</Radio>
            <p>{t("print.actualHelp")}</p>
          </div>
        </RadioGroup>
        <div className="modal-actions">
          <Button onPress={() => answer(undefined)}>{t("dialog.cancel")}</Button>
          <Button type="submit" className="is-default">
            {t("print.print")}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

/** FMT-OPEN-03: the "Transferring..." progress, with its per-file text. */
function TransferDialog({
  index,
  total,
  canceling,
  cancel,
}: {
  readonly index: number;
  readonly total: number;
  readonly canceling: boolean;
  readonly cancel: () => void;
}) {
  const t = useTranslation();
  const header = canceling
    ? t("file.transfer.canceling")
    : total > 1
      ? t("file.transfer.progress", { index, total })
      : t("file.transfer.initializing");
  return (
    <ModalDialog isOpen onClose={cancel} title={t("file.transfer.title")} closeDisabled={canceling}>
      <p role="status" aria-live="polite">
        {header}
      </p>
      <div className="modal-actions">
        <Button isDisabled={canceling} onPress={cancel}>
          {t("dialog.cancel")}
        </Button>
      </div>
    </ModalDialog>
  );
}

/** FMT-OPEN-03: a file failed to transfer, and the user chooses Retry, Skip or Cancel. */
function TransferErrorDialog({
  message,
  answer,
}: {
  readonly message: string;
  readonly answer: (choice: TransferChoice) => void;
}) {
  const t = useTranslation();
  return (
    <ModalDialog isOpen onClose={() => answer("cancel")} title={t("file.transferError.title")}>
      <p className="file-message">{message}</p>
      <div className="file-choice">
        <Button className="is-default" onPress={() => answer("retry")}>
          <AccessLabel text={t("file.transferError.retry")} />
        </Button>
        <p>{t("file.transferError.retryHelp")}</p>
      </div>
      <div className="file-choice">
        <Button onPress={() => answer("skip")}>
          <AccessLabel text={t("file.transferError.skip")} />
        </Button>
        <p>{t("file.transferError.skipHelp")}</p>
      </div>
      <div className="file-choice">
        <Button onPress={() => answer("cancel")}>{t("file.transferError.cancel")}</Button>
        <p>{t("file.transferError.cancelHelp")}</p>
      </div>
    </ModalDialog>
  );
}
