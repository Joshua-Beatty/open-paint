import { useTranslation } from "@openpaint/i18n/react";
import { OpenSourceList, useOpenSourceComponents } from "../help/OpenSourceList";
import { type OpenSourceComponent, THIRD_PARTY_NOTICES_URL } from "../help/open-source";
import "../help/help.css";

/**
 * The open-source licenses page (owner request, beyond SET-DLG-02): every bundled font, icon set
 * and library, from the same build-generated list as the About dialog and the notices file.
 */
export function LicensesPage({
  loadComponents,
}: {
  readonly loadComponents: () => Promise<readonly OpenSourceComponent[]>;
}) {
  const t = useTranslation();
  const components = useOpenSourceComponents(loadComponents);
  return (
    <>
      <p>{t("licenses.intro")}</p>
      <p>
        <a href={THIRD_PARTY_NOTICES_URL} target="_blank" rel="noopener noreferrer">
          {t("licenses.noticesLink")}
        </a>
      </p>
      {components === undefined ? (
        <p role="status">{t("licenses.loading")}</p>
      ) : (
        <OpenSourceList components={components} />
      )}
    </>
  );
}
