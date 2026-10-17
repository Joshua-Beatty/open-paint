import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { enUS, type MessageId, type MessageValues } from "./index";
import { I18nProvider, useTranslation } from "./react";

function Label({ id, values }: { id: MessageId; values?: MessageValues }) {
  const t = useTranslation();
  return <span>{t(id, values)}</span>;
}

describe("I18nProvider", () => {
  it("translates with the neutral en-US catalog when no provider is present", () => {
    expect(renderToStaticMarkup(<Label id="app.name" />)).toBe("<span>OpenPaint</span>");
  });

  it("passes message values through", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <Label id="history.layer" values={{ name: "Opacity" }} />
      </I18nProvider>,
    );
    expect(markup).toBe("<span>Layer Opacity</span>");
  });

  it("uses the locale and catalog it is given", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider locale="de-DE" catalog={{ ...enUS, "app.name": "OpenPaint DE" }}>
        <Label id="app.name" />
      </I18nProvider>,
    );
    expect(markup).toBe("<span>OpenPaint DE</span>");
  });
});
