import type { BackendSetting, EngineHandle, EngineStatus } from "@openpaint/engine";
import { useTranslation } from "@openpaint/i18n/react";
import type { GpuPerformanceClass, SettingsStore } from "@openpaint/storage";
import { useMemo, useState, useSyncExternalStore } from "react";
import { Button, ListBox, ListBoxItem } from "react-aria-components";
import type { ErrorReporter } from "../errors/reporter";
import { loadOpenSourceComponents, type OpenSourceComponent } from "../help/open-source";
import type { UpdateController } from "../help/updates";
import { ModalDialog } from "../shell/ModalDialog";
import { DiagnosticsPage } from "./DiagnosticsPage";
import { LicensesPage } from "./LicensesPage";
import "./settings.css";
import { type GraphicsStatusLine, graphicsStatusLine } from "./graphics-status";
import type { PenInputTracker } from "./pen-input";
import { SettingsForm } from "./SettingsForm";
import {
  backendBlock,
  CANVAS_BLOCK,
  DEFAULT_TOOL_BLOCK,
  PEN_BLOCK,
  QUALITY_BLOCK,
  SECTION_LABELS,
  SETTINGS_SECTIONS,
  type SettingsSection,
  TOOL_ROWS,
  UI_BLOCK,
} from "./settings-pages";
import { loadToolbarIntoDefaults, resetToolDefaults } from "./tool-defaults";

export interface SettingsDialogProps {
  readonly isOpen: boolean;
  /** The section that is selected when the dialog opens (SET-DLG-01). */
  readonly section: SettingsSection;
  readonly settings: SettingsStore | null;
  readonly engine: EngineHandle | undefined;
  readonly status: EngineStatus | undefined;
  readonly pen: PenInputTracker;
  readonly version: string;
  readonly sessionStart: Date;
  readonly errors: ErrorReporter;
  readonly updates?: UpdateController | undefined;
  readonly onReloadUpdate?: (() => void) | undefined;
  /** The bundled components of the licenses page; the build's list by default. */
  readonly loadComponents?: (() => Promise<readonly OpenSourceComponent[]>) | undefined;
  readonly onClose: () => void;
}

/**
 * The Settings dialog (SET-DLG-01..12): a section list and one page at a time, closed with the title
 * bar's close button or Esc. There is no OK, Cancel or Close button, because every change writes
 * straight to the live settings.
 */
export function SettingsDialog(props: SettingsDialogProps) {
  const t = useTranslation();
  return (
    <ModalDialog isOpen={props.isOpen} onClose={props.onClose} title={t("settings.title")} wide>
      {props.settings !== null && (
        <SettingsContent
          settings={props.settings}
          engine={props.engine}
          status={props.status}
          pen={props.pen}
          version={props.version}
          sessionStart={props.sessionStart}
          errors={props.errors}
          updates={props.updates}
          onReloadUpdate={props.onReloadUpdate}
          loadComponents={props.loadComponents ?? loadOpenSourceComponents}
          initialSection={props.section}
        />
      )}
    </ModalDialog>
  );
}

interface SettingsContentProps {
  readonly settings: SettingsStore;
  readonly engine: EngineHandle | undefined;
  readonly status: EngineStatus | undefined;
  readonly pen: PenInputTracker;
  readonly version: string;
  readonly sessionStart: Date;
  readonly errors: ErrorReporter;
  readonly updates: UpdateController | undefined;
  readonly onReloadUpdate: (() => void) | undefined;
  readonly loadComponents: () => Promise<readonly OpenSourceComponent[]>;
  readonly initialSection: SettingsSection;
}

/** Mounted while the dialog is open, so each open starts from the requested section. */
function SettingsContent({
  settings,
  engine,
  status,
  pen,
  version,
  sessionStart,
  errors,
  updates,
  onReloadUpdate,
  loadComponents,
  initialSection,
}: SettingsContentProps) {
  const t = useTranslation();
  const [section, setSection] = useState(initialSection);
  const gpuPerformanceClass: GpuPerformanceClass = status?.performanceClass ?? "VeryLow";
  const page = (() => {
    switch (section) {
      case "ui":
        return <UiPage settings={settings} gpuPerformanceClass={gpuPerformanceClass} />;
      case "canvas":
        return (
          <SettingsForm
            block={CANVAS_BLOCK}
            settings={settings}
            gpuPerformanceClass={gpuPerformanceClass}
          />
        );
      case "tools":
        return <ToolsPage settings={settings} gpuPerformanceClass={gpuPerformanceClass} />;
      case "pen":
        return <PenPage settings={settings} gpuPerformanceClass={gpuPerformanceClass} pen={pen} />;
      case "graphics":
        return (
          <GraphicsPage
            settings={settings}
            engine={engine}
            status={status}
            gpuPerformanceClass={gpuPerformanceClass}
          />
        );
      case "diagnostics":
        return (
          <DiagnosticsPage
            settings={settings}
            status={status}
            pen={pen}
            version={version}
            sessionStart={sessionStart}
            errors={errors}
            updates={updates}
            onReloadUpdate={onReloadUpdate}
          />
        );
      case "licenses":
        return <LicensesPage loadComponents={loadComponents} />;
    }
  })();
  return (
    <div className="settings-dialog">
      <ListBox
        aria-label={t("settings.sections")}
        className="settings-sections"
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[section]}
        onSelectionChange={(keys) => {
          if (keys === "all") return;
          const [next] = [...keys];
          if (next !== undefined) setSection(String(next) as SettingsSection);
        }}
      >
        {SETTINGS_SECTIONS.map((id) => (
          <ListBoxItem key={id} id={id} className="settings-section">
            {t(SECTION_LABELS[id])}
          </ListBoxItem>
        ))}
      </ListBox>
      <div className="settings-page">{page}</div>
    </div>
  );
}

/** Whether a media query matches now and when it changes (SET-DLG-03 forced colors). */
function useMediaMatch(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const media = globalThis.matchMedia?.(query);
      media?.addEventListener("change", notify);
      return () => media?.removeEventListener("change", notify);
    },
    () => globalThis.matchMedia?.(query).matches ?? false,
  );
}

interface PageProps {
  readonly settings: SettingsStore;
  readonly gpuPerformanceClass: GpuPerformanceClass;
}

/** SET-DLG-03: the controls, then the reset buttons, which are the only ones on this page. */
function UiPage({ settings, gpuPerformanceClass }: PageProps) {
  const t = useTranslation();
  const forcedColors = useMediaMatch("(forced-colors: active)");
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <SettingsForm
        block={UI_BLOCK}
        settings={settings}
        gpuPerformanceClass={gpuPerformanceClass}
        readOnlyPaths={forcedColors ? ["ui.theme"] : []}
      />
      {forcedColors && <p className="settings-note">{t("settings.note.forcedColors")}</p>}
      <div className="settings-actions">
        <Button onPress={() => setConfirming(true)}>{t("settings.ui.resetAll")}</Button>
        <Button onPress={() => settings.resetPanelLayout()}>{t("settings.ui.resetLayout")}</Button>
      </div>
      {confirming && (
        <section aria-label={t("settings.reset.title")} className="settings-confirm">
          <h3>{t("settings.reset.title")}</h3>
          <p>{t("settings.reset.text")}</p>
          <div className="settings-actions">
            <Button
              onPress={() => {
                settings.resetAll();
                setConfirming(false);
              }}
            >
              {t("settings.reset.confirm")}
            </Button>
            <Button onPress={() => setConfirming(false)}>{t("settings.reset.cancel")}</Button>
          </div>
        </section>
      )}
    </>
  );
}

/** SET-DLG-05: the default tool, the ten option rows, then Load From Toolbar and Reset. */
function ToolsPage({ settings, gpuPerformanceClass }: PageProps) {
  const t = useTranslation();
  return (
    <>
      <p>{t("settings.tools.intro")}</p>
      <SettingsForm
        block={DEFAULT_TOOL_BLOCK}
        settings={settings}
        gpuPerformanceClass={gpuPerformanceClass}
      />
      {TOOL_ROWS.map((row) => (
        <section key={row.caption} className="settings-tool-row">
          <h3>{t(row.caption)}</h3>
          <SettingsForm
            block={row.block}
            settings={settings}
            gpuPerformanceClass={gpuPerformanceClass}
          />
        </section>
      ))}
      <div className="settings-actions">
        <Button onPress={() => loadToolbarIntoDefaults(settings)}>
          {t("settings.tools.loadToolbar")}
        </Button>
        <Button onPress={() => resetToolDefaults(settings)}>{t("settings.tools.reset")}</Button>
      </div>
    </>
  );
}

/** SET-DLG-06: the pressure setting, and a note until a pen has been seen. */
function PenPage({
  settings,
  gpuPerformanceClass,
  pen,
}: PageProps & { readonly pen: PenInputTracker }) {
  const t = useTranslation();
  const detected = useSyncExternalStore(pen.subscribe, () => pen.known);
  return (
    <>
      <SettingsForm
        block={PEN_BLOCK}
        settings={settings}
        gpuPerformanceClass={gpuPerformanceClass}
      />
      {!detected && <p className="settings-note">{t("settings.pen.none")}</p>}
    </>
  );
}

function graphicsText(t: ReturnType<typeof useTranslation>, line: GraphicsStatusLine): string {
  switch (line.kind) {
    case "active": {
      const backend = t("settings.value.webgpuBackend");
      return line.adapter === undefined
        ? t("settings.graphics.activeNoAdapter", { backend })
        : t("settings.graphics.active", { backend, adapter: line.adapter });
    }
    case "unavailable":
      return t("settings.graphics.unavailable");
    case "off":
      return t("settings.graphics.off");
    case "fallback":
      return t("graphics.status.deviceLossFallback");
  }
}

interface GraphicsPageProps extends PageProps {
  readonly engine: EngineHandle | undefined;
  readonly status: EngineStatus | undefined;
}

/**
 * SET-DLG-07: the backend choice, its status line and the two quality defaults. A backend change
 * applies at once and resets the GPU quality default for the new device class (SET-DLG-07a).
 */
function GraphicsPage({ settings, engine, status, gpuPerformanceClass }: GraphicsPageProps) {
  const t = useTranslation();
  const webgpuAvailable = status?.webgpuAvailable ?? false;
  const resolved =
    status === undefined ? undefined : status.backend === "webgpu" ? "WebGPU" : "Cpu";
  const block = useMemo(() => backendBlock(webgpuAvailable, resolved), [webgpuAvailable, resolved]);
  const onCommit = (path: string, value: unknown): boolean => {
    if (path !== "graphics.backend") return false;
    void applyBackend(settings, engine, gpuPerformanceClass, String(value)).catch(
      (error: unknown) => console.error("The rendering backend could not be changed.", error),
    );
    return true;
  };
  const line = status === undefined ? undefined : graphicsStatusLine(status);
  return (
    <>
      <SettingsForm
        key={`${String(webgpuAvailable)}-${String(resolved)}`}
        block={block}
        settings={settings}
        gpuPerformanceClass={gpuPerformanceClass}
        onCommit={onCommit}
      />
      {!webgpuAvailable && <p className="settings-note">{t("settings.graphics.unsupported")}</p>}
      {line !== undefined && <p className="settings-status">{graphicsText(t, line)}</p>}
      <SettingsForm
        block={QUALITY_BLOCK}
        settings={settings}
        gpuPerformanceClass={gpuPerformanceClass}
      />
    </>
  );
}

/**
 * Switches the engine to `backend`, then stores the backend, the GPU quality default for the class
 * the engine measured, and the device-loss flags it reports (SET-DLG-07, SET-STO-03).
 */
async function applyBackend(
  settings: SettingsStore,
  engine: EngineHandle | undefined,
  gpuPerformanceClass: GpuPerformanceClass,
  backend: string,
): Promise<void> {
  if (engine === undefined) {
    settings.changeBackend(backend, gpuPerformanceClass);
    return;
  }
  const next = await engine.setBackend(backend as BackendSetting);
  settings.changeBackend(backend, next.performanceClass);
  settings.set("graphics.errorFlags", next.errorFlags);
}
