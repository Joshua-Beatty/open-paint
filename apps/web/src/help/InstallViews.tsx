import { useTranslation } from "@openpaint/i18n/react";
import { useSyncExternalStore } from "react";
import { Button } from "react-aria-components";
import type { InstallHint } from "./install-prompt";

export interface InstallNoticeProps {
  readonly install: InstallHint;
}

/** The first-run hint that offers to install the app (08 SET-LIFE-01 step 4). It never blocks the editor. */
export function InstallNotice({ install }: InstallNoticeProps) {
  const t = useTranslation();
  const { visible } = useSyncExternalStore(install.subscribe, () => install.snapshot);
  if (!visible) return null;
  return (
    <section className="app-notice app-install-hint" aria-label={t("install.hint")}>
      <p>{t("install.hint")}</p>
      <div className="app-update-actions">
        <Button onPress={() => void install.install()}>{t("install.action")}</Button>
        <Button onPress={() => install.dismiss()}>{t("install.notNow")}</Button>
      </div>
    </section>
  );
}
