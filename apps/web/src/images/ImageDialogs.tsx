import {
  CANVAS_ANCHORS,
  type CanvasAnchor,
  Document,
  OperationCanceledError,
  OutOfMemoryError,
  type ResampleOptions,
  type Resolution,
  type Size,
} from "@openpaint/document";
import { useTranslation } from "@openpaint/i18n/react";
import type { SettingsStore } from "@openpaint/storage";
import { useEffect, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Form,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Radio,
  RadioGroup,
  Select,
  SelectValue,
  VisuallyHidden,
} from "react-aria-components";
import type { Rgba } from "../colors/color-math";
import { PRIMARY_COLOR_PATH, readStoredColor, SECONDARY_COLOR_PATH } from "../colors/use-colors";
import { newDocumentAccountant } from "../errors/memory-budget";
import { MessageDialog } from "../shell/MessageDialog";
import { ModalDialog } from "../shell/ModalDialog";
import { cpuOffloader } from "../workers/cpu-offloader";
import { readClipboardNewSize } from "./clipboard-size";
import { ResizeProgressDialog } from "./ResizeProgressDialog";
import { SizeFields } from "./SizeFields";
import {
  anchorFromSetting,
  anchorSetting,
  CANVAS_ANCHOR_MESSAGES,
  defaultDotsPerUnit,
  defaultNewImageSize,
  dotsPerUnitOf,
  draftResolution,
  FILL_CHOICES,
  FILL_MESSAGES,
  type FillChoice,
  fillColor,
  fillFromSetting,
  gammaSetting,
  linearLightFromSetting,
  memoryBytes,
  memoryText,
  printUnitFromSetting,
  printUnitSetting,
  RESIZE_RESAMPLING_CHOICES,
  RESIZE_RESAMPLING_MESSAGES,
  type ResizeResampling,
  resamplingFromSetting,
  type SizeDraft,
  sizeDraft,
  targetSize,
} from "./size-draft";

/** The image dialogs of the Image menu and File > New (DOC-NEW-01, DOC-IMG-02, DOC-IMG-03). */
export type ImageDialogKind = "new" | "resize" | "canvasSize";

const DEFAULT_PRIMARY: Rgba = { r: 0, g: 0, b: 0, a: 255 };
const DEFAULT_SECONDARY: Rgba = { r: 255, g: 255, b: 255, a: 255 };

/** A Resize request as the dialog hands it to the host. */
interface ResizeRequest {
  readonly size: Size;
  readonly options: ResampleOptions;
  readonly resolution: Resolution;
}

/** The Resize job while it runs: its progress, and the cancel that stops it. */
interface ResizeJob {
  readonly percent: number | undefined;
  readonly canceling: boolean;
  readonly cancel: () => void;
}

/** Lets the UI paint and handle clicks between resampling slices (DOC-IMG-02). */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The New dialog's starting size: the clipboard's when given, else the screen default (DOC-NEW-01). */
function defaultSize(clipboard?: Size): Size {
  return defaultNewImageSize({
    screen: { width: window.screen.width, height: window.screen.height },
    devicePixelRatio: window.devicePixelRatio,
    ...(clipboard === undefined ? {} : { clipboard }),
  });
}

export interface ImageDialogsProps {
  /** The dialog to show, or undefined when none is open. */
  readonly kind: ImageDialogKind | undefined;
  /** The active image. Resize and Canvas Size need one. */
  readonly doc: Document | undefined;
  /** The settings that remember the last used values. Nothing opens until they load. */
  readonly settings: SettingsStore | null;
  readonly onClose: () => void;
  /** Receives the document a New Image dialog created. */
  readonly onCreate: (doc: Document) => void;
  /** The clipboard's size for the New dialog's default (DOC-NEW-01). Never prompts. */
  readonly readClipboardSize?: () => Promise<Size | undefined>;
}

interface Failure {
  readonly title: string;
  readonly message: string;
}

/**
 * Hosts the New, Resize and Canvas Size dialogs and the message for a failed operation. A failed
 * operation closes its dialog and shows the out-of-memory message, and the image is not changed.
 */
export function ImageDialogs({
  kind,
  doc,
  settings,
  onClose,
  onCreate,
  readClipboardSize = readClipboardNewSize,
}: ImageDialogsProps) {
  const t = useTranslation();
  const [failure, setFailure] = useState<Failure | undefined>(undefined);
  const [resize, setResize] = useState<ResizeJob | undefined>(undefined);
  const runResize = (target: Document, request: ResizeRequest) => {
    const { size, options, resolution } = request;
    if (size.width === target.width && size.height === target.height) {
      target.resize(size, options, resolution);
      return;
    }
    let canceled = false;
    const cancel = () => {
      canceled = true;
      setResize((current) => current && { ...current, canceling: true });
    };
    setResize({ percent: undefined, canceling: false, cancel });
    target
      .resizeWithProgress(size, options, resolution, {
        resample: (source, width, height, filter) =>
          cpuOffloader().resample(source, width, height, filter),
        isCanceled: () => canceled,
        onProgress: (fraction) =>
          setResize((current) => current && { ...current, percent: Math.round(fraction * 100) }),
        pause: yieldToEventLoop,
      })
      .then(
        () => setResize(undefined),
        (error: unknown) => {
          setResize(undefined);
          if (error instanceof OperationCanceledError) return;
          if (!(error instanceof OutOfMemoryError)) throw error;
          setFailure({ title: t("image.resize.title"), message: t("image.error.resizeMemory") });
        },
      );
  };
  const fail = (title: string, message: string) => {
    setFailure({ title, message });
    onClose();
  };
  return (
    <>
      {settings !== null && kind === "new" && (
        <NewImageDialogHost
          settings={settings}
          readClipboardSize={readClipboardSize}
          onCreate={onCreate}
          onClose={onClose}
          onFail={fail}
        />
      )}
      {settings !== null && doc !== undefined && kind === "resize" && (
        <ResizeDialog settings={settings} doc={doc} onClose={onClose} onResize={runResize} />
      )}
      {settings !== null && doc !== undefined && kind === "canvasSize" && (
        <CanvasSizeDialog settings={settings} doc={doc} onClose={onClose} onFail={fail} />
      )}
      <ResizeProgressDialog
        isOpen={resize !== undefined}
        percent={resize?.percent}
        canceling={resize?.canceling ?? false}
        onCancel={() => resize?.cancel()}
      />
      <MessageDialog
        isOpen={failure !== undefined}
        title={failure?.title ?? ""}
        message={failure?.message ?? ""}
        onClose={() => setFailure(undefined)}
      />
    </>
  );
}

interface NewImageDialogProps {
  readonly settings: SettingsStore;
  readonly readClipboardSize: () => Promise<Size | undefined>;
  readonly onCreate: (doc: Document) => void;
  readonly onClose: () => void;
  readonly onFail: (title: string, message: string) => void;
}

/**
 * How long the New dialog waits for the clipboard's size before it opens with the default size.
 * A granted read answers in a few milliseconds; a slow or stuck one must not hold the dialog.
 */
export const CLIPBOARD_SIZE_WAIT_MS = 250;

/** How the New dialog starts: the clipboard's size if it came in time, or a read still running. */
type NewImageStart =
  | { readonly clipboard: Size | undefined }
  | { readonly late: Promise<Size | undefined> };

/**
 * Opens the New dialog once its starting size is known, so its first painted frame already shows
 * the clipboard's size (DOC-NEW-01). It waits for the clipboard read up to
 * `CLIPBOARD_SIZE_WAIT_MS`, then opens with the default size and takes a later answer unless the
 * user has typed a size by then.
 */
function NewImageDialogHost(props: NewImageDialogProps) {
  const { readClipboardSize } = props;
  const [start, setStart] = useState<NewImageStart | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const read = readClipboardSize().catch(() => undefined);
    const timer = setTimeout(() => {
      if (live) setStart((current) => current ?? { late: read });
    }, CLIPBOARD_SIZE_WAIT_MS);
    void read.then((clipboard) => {
      clearTimeout(timer);
      if (live) setStart((current) => current ?? { clipboard });
    });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [readClipboardSize]);
  if (start === undefined) return null;
  return <NewImageDialog {...props} start={start} />;
}

function NewImageDialog({
  settings,
  start,
  onCreate,
  onClose,
  onFail,
}: NewImageDialogProps & { readonly start: NewImageStart }) {
  const t = useTranslation();
  const [base, setBase] = useState<Size>(() =>
    defaultSize("clipboard" in start ? start.clipboard : undefined),
  );
  const [draft, setDraft] = useState<SizeDraft>(() => {
    const unit = printUnitFromSetting(settings.get("workspace.lastNonPixelUnits"));
    return sizeDraft(base, {
      keepAspect: settings.get("workspace.maintainAspectRatio.newImage") === true,
      unit,
      dotsPerUnit: defaultDotsPerUnit(unit),
    });
  });
  const edited = useRef(false);
  useEffect(() => {
    if (!("late" in start)) return undefined;
    let live = true;
    void start.late.then((clipboard) => {
      if (!live || clipboard === undefined || edited.current) return;
      const next = defaultSize(clipboard);
      setBase(next);
      setDraft((current) => ({ ...current, width: next.width, height: next.height }));
    });
    return () => {
      live = false;
    };
  }, [start]);
  const changeDraft = (next: SizeDraft) => {
    edited.current = true;
    setDraft(next);
  };
  const size = targetSize(draft, base);
  const resolution = draftResolution(draft);
  const submit = () => {
    if (size === undefined || resolution === undefined) return;
    try {
      const doc = Document.createBlank({
        width: size.width,
        height: size.height,
        resolution,
        accountant: newDocumentAccountant(),
      });
      remember(settings, "workspace.maintainAspectRatio.newImage", draft);
      onCreate(doc);
      onClose();
    } catch (error) {
      if (!(error instanceof OutOfMemoryError)) throw error;
      onFail(t("image.new.title"), t("image.error.newMemory"));
    }
  };
  return (
    <ModalDialog isOpen onClose={onClose} title={t("image.new.title")}>
      <Form
        className="image-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <SizeFields current={base} draft={draft} onChange={changeDraft} percentage={false} />
        {size !== undefined && (
          <p className="image-size-memory">
            {t("image.sizeFields.newSize", { size: memoryText(memoryBytes(size, 1), t) })}
          </p>
        )}
        <DialogActions valid={size !== undefined && resolution !== undefined} onCancel={onClose} />
      </Form>
    </ModalDialog>
  );
}

interface ChangeDialogProps {
  readonly settings: SettingsStore;
  readonly doc: Document;
  readonly onClose: () => void;
  readonly onFail: (title: string, message: string) => void;
}

interface ResizeDialogProps {
  readonly settings: SettingsStore;
  readonly doc: Document;
  readonly onClose: () => void;
  readonly onResize: (target: Document, request: ResizeRequest) => void;
}

function ResizeDialog({ settings, doc, onClose, onResize }: ResizeDialogProps) {
  const t = useTranslation();
  const current = { width: doc.width, height: doc.height };
  const [draft, setDraft] = useState<SizeDraft>(() => {
    const unit = printUnitFromSetting(settings.get("workspace.lastNonPixelUnits"));
    return sizeDraft(current, {
      keepAspect: settings.get("workspace.maintainAspectRatio.resize") === true,
      unit,
      dotsPerUnit: dotsPerUnitOf(doc.resolution, unit),
    });
  });
  const [resampling, setResampling] = useState<ResizeResampling>(() =>
    resamplingFromSetting(settings.get("workspace.lastResampling")),
  );
  const [linearLight, setLinearLight] = useState(() =>
    linearLightFromSetting(settings.get("workspace.lastResizeGammaMode")),
  );
  const size = targetSize(draft, current);
  const resolution = draftResolution(draft);
  const submit = () => {
    if (size === undefined || resolution === undefined) return;
    remember(settings, "workspace.maintainAspectRatio.resize", draft);
    settings.set("workspace.lastResampling", resampling);
    settings.set("workspace.lastResizeGammaMode", gammaSetting(linearLight));
    onResize(doc, { size, options: { filter: resampling, linearLight }, resolution });
    onClose();
  };
  return (
    <ModalDialog isOpen onClose={onClose} title={t("image.resize.title")}>
      <Form
        className="image-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="image-size-row">
          <Select
            selectedKey={resampling}
            onSelectionChange={(key) => {
              const choice = RESIZE_RESAMPLING_CHOICES.find((candidate) => candidate === key);
              if (choice !== undefined) setResampling(choice);
            }}
          >
            <Label>{t("image.resampling.label")}</Label>
            <Button>
              <SelectValue />
            </Button>
            <Popover>
              <ListBox>
                {RESIZE_RESAMPLING_CHOICES.map((choice) => (
                  <ListBoxItem key={choice} id={choice}>
                    {t(RESIZE_RESAMPLING_MESSAGES[choice])}
                  </ListBoxItem>
                ))}
              </ListBox>
            </Popover>
          </Select>
          <Button onPress={() => setResampling("bicubic")}>{t("property.reset")}</Button>
        </div>
        <Checkbox isSelected={linearLight} onChange={setLinearLight}>
          {t("image.resampling.gamma")}
        </Checkbox>
        <SizeFields current={current} draft={draft} onChange={setDraft} percentage />
        <CurrentAndNewSize doc={doc} size={size} />
        <DialogActions valid={size !== undefined && resolution !== undefined} onCancel={onClose} />
      </Form>
    </ModalDialog>
  );
}

function CanvasSizeDialog({ settings, doc, onClose, onFail }: ChangeDialogProps) {
  const t = useTranslation();
  const current = { width: doc.width, height: doc.height };
  const [draft, setDraft] = useState<SizeDraft>(() => {
    const unit = printUnitFromSetting(settings.get("workspace.lastNonPixelUnits"));
    return sizeDraft(current, {
      keepAspect: settings.get("workspace.maintainAspectRatio.canvasSize") === true,
      unit,
      dotsPerUnit: dotsPerUnitOf(doc.resolution, unit),
    });
  });
  const [anchor, setAnchor] = useState<CanvasAnchor>(() =>
    anchorFromSetting(settings.get("workspace.lastCanvasSizeAnchor")),
  );
  const [fill, setFill] = useState<FillChoice>(() =>
    fillFromSetting(settings.get("workspace.lastCanvasSizeFill")),
  );
  const size = targetSize(draft, current);
  const resolution = draftResolution(draft);
  const submit = () => {
    if (size === undefined || resolution === undefined) return;
    const color = fillColor(
      fill,
      readStoredColor(settings, PRIMARY_COLOR_PATH, DEFAULT_PRIMARY),
      readStoredColor(settings, SECONDARY_COLOR_PATH, DEFAULT_SECONDARY),
    );
    try {
      doc.resizeCanvas(size, anchor, color, resolution);
    } catch (error) {
      if (!(error instanceof OutOfMemoryError)) throw error;
      onFail(t("image.canvasSize.title"), t("image.error.resizeMemory"));
      return;
    }
    remember(settings, "workspace.maintainAspectRatio.canvasSize", draft);
    settings.set("workspace.lastCanvasSizeAnchor", anchorSetting(anchor));
    settings.set("workspace.lastCanvasSizeFill", fill);
    onClose();
  };
  return (
    <ModalDialog isOpen onClose={onClose} title={t("image.canvasSize.title")}>
      <Form
        className="image-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <SizeFields current={current} draft={draft} onChange={setDraft} percentage />
        <CurrentAndNewSize doc={doc} size={size} />
        <h3 className="image-size-heading">{t("image.anchor.header")}</h3>
        <div className="image-anchor">
          <RadioGroup
            aria-label={t("image.anchor.header")}
            className="image-anchor-grid"
            value={anchor}
            onChange={(key) => {
              const next = CANVAS_ANCHORS.find((candidate) => candidate === key);
              if (next !== undefined) setAnchor(next);
            }}
          >
            {CANVAS_ANCHORS.map((choice) => (
              <Radio key={choice} value={choice}>
                <VisuallyHidden>{t(CANVAS_ANCHOR_MESSAGES[choice])}</VisuallyHidden>
              </Radio>
            ))}
          </RadioGroup>
          <Select
            selectedKey={anchor}
            onSelectionChange={(key) => {
              const next = CANVAS_ANCHORS.find((candidate) => candidate === key);
              if (next !== undefined) setAnchor(next);
            }}
          >
            <Label>{t("image.anchor.label")}</Label>
            <Button>
              <SelectValue />
            </Button>
            <Popover>
              <ListBox>
                {CANVAS_ANCHORS.map((choice) => (
                  <ListBoxItem key={choice} id={choice}>
                    {t(CANVAS_ANCHOR_MESSAGES[choice])}
                  </ListBoxItem>
                ))}
              </ListBox>
            </Popover>
          </Select>
        </div>
        <Select
          selectedKey={fill}
          onSelectionChange={(key) => {
            const next = FILL_CHOICES.find((candidate) => candidate === key);
            if (next !== undefined) setFill(next);
          }}
        >
          <Label>{t("image.fill.label")}</Label>
          <Button>
            <SelectValue />
          </Button>
          <Popover>
            <ListBox>
              {FILL_CHOICES.map((choice) => (
                <ListBoxItem key={choice} id={choice}>
                  {t(FILL_MESSAGES[choice])}
                </ListBoxItem>
              ))}
            </ListBox>
          </Popover>
        </Select>
        <DialogActions valid={size !== undefined && resolution !== undefined} onCancel={onClose} />
      </Form>
    </ModalDialog>
  );
}

function CurrentAndNewSize({
  doc,
  size,
}: {
  readonly doc: Document;
  readonly size: Size | undefined;
}) {
  const t = useTranslation();
  return (
    <div className="image-size-summary">
      <p>
        {t("image.sizeFields.currentSize")}{" "}
        {t("image.sizeFields.pixelCount", { width: doc.width, height: doc.height })}
      </p>
      {size !== undefined && (
        <p className="image-size-memory">
          {t("image.sizeFields.newSize", {
            size: memoryText(memoryBytes(size, doc.layerCount), t),
          })}
        </p>
      )}
    </div>
  );
}

function DialogActions({
  valid,
  onCancel,
}: {
  readonly valid: boolean;
  readonly onCancel: () => void;
}) {
  const t = useTranslation();
  return (
    <div className="modal-actions">
      <Button onPress={onCancel}>{t("dialog.cancel")}</Button>
      <Button type="submit" className="is-default" isDisabled={!valid}>
        {t("dialog.ok")}
      </Button>
    </div>
  );
}

/** Saves the dialog's aspect-ratio choice and its print unit (DOC-NEW-01, DOC-IMG-02/03). */
function remember(settings: SettingsStore, aspectPath: string, draft: SizeDraft): void {
  settings.set(aspectPath, draft.keepAspect);
  settings.set("workspace.lastNonPixelUnits", printUnitSetting(draft.unit));
}
