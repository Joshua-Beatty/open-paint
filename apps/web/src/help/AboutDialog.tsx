import { useTranslation } from "@openpaint/i18n/react";
import { ModalDialog } from "../shell/ModalDialog";
import { OpenSourceList, useOpenSourceComponents } from "./OpenSourceList";
import { type OpenSourceComponent, THIRD_PARTY_NOTICES_URL } from "./open-source";
import { UpdateCheck } from "./UpdateViews";
import type { UpdateController } from "./updates";
import "./help.css";

export interface AboutDialogProps {
  readonly isOpen: boolean;
  readonly version: string;
  /** The build time as an ISO 8601 string (SET-HELP-02). */
  readonly buildDate: string;
  readonly loadComponents: () => Promise<readonly OpenSourceComponent[]>;
  readonly updates: UpdateController;
  readonly onReload: () => void;
  readonly onClose: () => void;
}

/** SET-HELP-02: the product, its version and build date, the license, and the bundled components. */
export function AboutDialog({ isOpen, onClose, ...props }: AboutDialogProps) {
  const t = useTranslation();
  return (
    <ModalDialog isOpen={isOpen} onClose={onClose} title={t("about.title")} wide>
      {isOpen && <AboutBody {...props} />}
    </ModalDialog>
  );
}

type AboutBodyProps = Omit<AboutDialogProps, "isOpen" | "onClose">;

/** Mounted while the dialog is open, so each open lists the components afresh. */
function AboutBody({ version, buildDate, loadComponents, updates, onReload }: AboutBodyProps) {
  const t = useTranslation();
  const components = useOpenSourceComponents(loadComponents);

  const built = new Date(buildDate);

  return (
    <div className="about">
      <img
        className="about-banner"
        src="/icon.svg"
        alt={t("about.banner")}
        width={64}
        height={64}
      />
      <p className="about-name">{t("app.name")}</p>
      <p>{t("about.version", { version })}</p>
      <p>
        {t("about.build", {
          date: new Intl.DateTimeFormat("en-US", { dateStyle: "long" }).format(built),
        })}
      </p>
      <p>{t("about.copyright", { year: String(built.getFullYear()) })}</p>
      <h3>{t("about.credits")}</h3>
      <p>{t("about.creditsNames")}</p>
      <h3>{t("about.components")}</h3>
      <div className="about-component-list">
        <OpenSourceList components={components ?? []} />
      </div>
      <p>
        <a href={THIRD_PARTY_NOTICES_URL} target="_blank" rel="noopener noreferrer">
          {t("licenses.noticesLink")}
        </a>
      </p>
      <UpdateCheck updates={updates} onReload={onReload} />
    </div>
  );
}
