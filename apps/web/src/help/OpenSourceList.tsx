import type { MessageId } from "@openpaint/i18n";
import { useTranslation } from "@openpaint/i18n/react";
import { useEffect, useId, useState } from "react";
import { Button } from "react-aria-components";
import { COMPONENT_KINDS, type ComponentKind, type OpenSourceComponent } from "./open-source";

const KIND_LABELS = {
  font: "licenses.group.font",
  icons: "licenses.group.icons",
  library: "licenses.group.library",
  codec: "licenses.group.codec",
  rust: "licenses.group.rust",
} as const satisfies Record<ComponentKind, MessageId>;

export function componentKey(component: OpenSourceComponent): string {
  return `${component.name}@${component.version}`;
}

/** The component list, loaded when the view mounts. `undefined` until it is in. */
export function useOpenSourceComponents(
  load: () => Promise<readonly OpenSourceComponent[]>,
): readonly OpenSourceComponent[] | undefined {
  const [components, setComponents] = useState<readonly OpenSourceComponent[]>();
  useEffect(() => {
    let active = true;
    load().then(
      (list) => {
        if (active) setComponents(list);
      },
      (error: unknown) =>
        console.error("The open-source component list could not be loaded.", error),
    );
    return () => {
      active = false;
    };
  }, [load]);
  return components;
}

/**
 * The bundled third-party components by kind (fonts, icon sets, libraries), each with its version
 * and license; pressing one shows its copyright, project link and full license text below it
 * (SET-HELP-02). The About dialog and the Licenses settings page both show this list.
 */
export function OpenSourceList({
  components,
  className,
}: {
  readonly components: readonly OpenSourceComponent[];
  readonly className?: string;
}) {
  const t = useTranslation();
  const [selected, setSelected] = useState<string>();
  const idPrefix = useId();
  return (
    <div className={["open-source-list", className].filter(Boolean).join(" ")}>
      {COMPONENT_KINDS.map((kind) => {
        const group = components.filter((component) => component.kind === kind);
        if (group.length === 0) return null;
        const headingId = `${idPrefix}-${kind}`;
        return (
          <section key={kind} aria-labelledby={headingId}>
            <h4 id={headingId} className="open-source-heading">
              {t(KIND_LABELS[kind])}
            </h4>
            <ul className="about-components">
              {group.map((component) => {
                const key = componentKey(component);
                const open = selected === key;
                const detailId = `${idPrefix}-${key}`;
                return (
                  <li key={key}>
                    <Button
                      className="about-component"
                      aria-expanded={open}
                      aria-controls={open ? detailId : undefined}
                      onPress={() => setSelected(open ? undefined : key)}
                    >
                      <span>{`${component.title} ${component.version}`}</span>
                      <span>{component.license}</span>
                    </Button>
                    {open && <ComponentDetail id={detailId} component={component} />}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function ComponentDetail({
  id,
  component,
}: {
  readonly id: string;
  readonly component: OpenSourceComponent;
}) {
  const t = useTranslation();
  return (
    <section id={id} className="about-license" aria-label={componentKey(component)}>
      {component.title !== component.name && (
        <p>{t("licenses.package", { name: component.name })}</p>
      )}
      <p>{t("about.component.license", { license: component.license })}</p>
      {component.copyright !== "" && <p className="about-copyright">{component.copyright}</p>}
      {component.url !== "" && (
        <p>
          {t("about.component.project")}:{" "}
          <a href={component.url} target="_blank" rel="noopener noreferrer">
            {component.url}
          </a>
        </p>
      )}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the scrolling text must take focus to scroll from the keyboard (WCAG 2.1.1) */}
      <pre tabIndex={0}>
        {component.licenseText === "" ? t("about.component.noText") : component.licenseText}
      </pre>
    </section>
  );
}
