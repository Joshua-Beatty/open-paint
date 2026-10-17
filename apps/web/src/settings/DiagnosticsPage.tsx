import type { EngineStatus } from "@openpaint/engine";
import { useTranslation } from "@openpaint/i18n/react";
import type { SettingsStore } from "@openpaint/storage";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "react-aria-components";
import type { ErrorReporter } from "../errors/reporter";
import { UpdateCheck } from "../help/UpdateViews";
import type { UpdateController } from "../help/updates";
import {
  type DiagnosticGroup,
  type DiagnosticsFacts,
  diagnosticGroups,
  diagnosticsText,
  megabyteText,
} from "./diagnostics";
import { gatherDiagnosticsFacts } from "./diagnostics-facts";
import { ErrorLogSection } from "./ErrorLogSection";
import type { PenInputTracker } from "./pen-input";
import { useSetting } from "./use-setting";

/** A stable subscription for a page without an update controller. */
const subscribeNothing = () => () => undefined;

export interface DiagnosticsPageProps {
  readonly settings: SettingsStore;
  readonly status: EngineStatus | undefined;
  readonly pen: PenInputTracker;
  readonly version: string;
  readonly sessionStart: Date;
  /** The local error log and the report source (SET-ERR-01, SET-DLG-12). */
  readonly errors: ErrorReporter;
  /** Enables "Check for updates" (SET-DLG-09). */
  readonly updates?: UpdateController | undefined;
  readonly onReloadUpdate?: (() => void) | undefined;
}

/**
 * SET-DLG-12: storage usage and persistence, then the diagnostics report as an Item and Value table.
 * The report is gathered when the page opens and again when the engine or pen state changes.
 */
export function DiagnosticsPage({
  settings,
  status,
  pen,
  version,
  sessionStart,
  errors,
  updates,
  onReloadUpdate,
}: DiagnosticsPageProps) {
  const t = useTranslation();
  const penDetected = useSyncExternalStore(pen.subscribe, () => pen.detected);
  const animations = useSetting(settings, "ui.animations") !== false;
  const workerPolicy = String(settings.get("performance.workerPolicy") ?? "ThreeQuarters");
  const [facts, setFacts] = useState<DiagnosticsFacts>();
  const [message, setMessage] = useState<string>();

  const updateSnapshot = useSyncExternalStore(
    updates?.subscribe ?? subscribeNothing,
    () => updates?.snapshot,
  );
  const updateState = updateSnapshot?.state;
  const lastCheck = updates?.lastCheckedAt;

  useEffect(() => {
    let active = true;
    void gatherDiagnosticsFacts({
      version,
      buildDate: __APP_BUILD_DATE__,
      ...(updateState === undefined ? {} : { update: { state: updateState, lastCheck } }),
      sessionStart,
      status,
      penDetected,
      animations,
      workerPolicy,
    }).then((next) => {
      if (active) setFacts(next);
    });
    return () => {
      active = false;
    };
  }, [
    version,
    sessionStart,
    status,
    penDetected,
    animations,
    workerPolicy,
    updateState,
    lastCheck,
  ]);

  const groups = facts === undefined ? undefined : diagnosticGroups(facts, t);
  const storage = facts?.storage;

  const copy = async () => {
    if (facts === undefined) return;
    const header = `${t("app.name")} ${version}`;
    try {
      await navigator.clipboard.writeText(diagnosticsText(diagnosticGroups(facts, t), header));
      setMessage(t("settings.diagnostics.copied"));
    } catch {
      setMessage(t("settings.diagnostics.copyFailed"));
    }
  };

  return (
    <>
      <section className="settings-storage">
        <h3>{t("settings.diagnostics.storage")}</h3>
        <p>
          {storage === undefined
            ? t("settings.diagnostics.storageUnknown")
            : t("settings.diagnostics.storageUsed", {
                used: megabyteText(t, storage.usage),
                quota: megabyteText(t, storage.quota),
              })}
        </p>
        <p>
          {t("settings.diagnostics.item.persistent")}:{" "}
          {storage?.persisted === undefined
            ? t("settings.value.unknown")
            : t(storage.persisted ? "settings.value.yes" : "settings.value.no")}
        </p>
      </section>
      {groups !== undefined && (
        <table className="settings-diagnostics">
          <thead>
            <tr>
              <th scope="col">{t("settings.diagnostics.item")}</th>
              <th scope="col">{t("settings.diagnostics.value")}</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <GroupRows key={group.title} group={group} />
            ))}
          </tbody>
        </table>
      )}
      <ErrorLogSection errors={errors} />
      <div className="settings-actions">
        <Button onPress={() => void copy()}>{t("settings.diagnostics.copy")}</Button>
      </div>
      {updates !== undefined && <UpdateCheck updates={updates} onReload={onReloadUpdate} />}
      {message !== undefined && (
        <p aria-live="polite" className="settings-status">
          {message}
        </p>
      )}
    </>
  );
}

function GroupRows({ group }: { readonly group: DiagnosticGroup }) {
  return (
    <>
      <tr>
        <th scope="rowgroup" colSpan={2}>
          {group.title}
        </th>
      </tr>
      {group.items.map((item) => (
        <tr key={item.label}>
          <td>{item.label}</td>
          <td>{item.value}</td>
        </tr>
      ))}
    </>
  );
}
