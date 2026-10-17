import { type EffectSource, LAYER_UNDERLAY_KEY, SOURCE_UNDERLAY_KEY } from "@openpaint/effects";
import {
  EffectErrorDialog,
  PropertyDialog,
  type PropertyServices,
  RenderProgressDialog,
} from "@openpaint/ui";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { CUSTOM_DIALOGS } from "./custom-dialogs";
import type { EffectRuntime } from "./effect-runtime";
import { layerThumbnailUrl, sourceThumbnailUrl } from "./source-thumbnail";

/**
 * The thumbnail a loader makes for `source`, once it is ready. Until then, and for another source,
 * there is none, so a stale image never shows under a new effect.
 */
function useSourceUrl(
  source: EffectSource | undefined,
  load: (source: EffectSource | undefined) => Promise<string | undefined>,
): string | undefined {
  const [loaded, setLoaded] = useState<{
    readonly source: EffectSource | undefined;
    readonly url: string | undefined;
  }>({ source: undefined, url: undefined });
  useEffect(() => {
    let current = true;
    void load(source).then((url) => {
      if (current) setLoaded({ source, url });
    });
    return () => {
      current = false;
    };
  }, [source, load]);
  return loaded.source === source ? loaded.url : undefined;
}

/**
 * The dialogs of the effect runtime: the generated configuration dialog with its live preview, the
 * progress dialog while a render finishes, and the error message (FX-FW-UI-01, FX-FW-PROGRESS-01).
 */
export function EffectDialogs({
  runtime,
  onViewErrorLog,
}: {
  readonly runtime: EffectRuntime;
  /** Opens Settings › Diagnostics from the error dialog (SET-ERR-03). */
  readonly onViewErrorLog?: () => void;
}) {
  const state = useSyncExternalStore(runtime.subscribe, () => runtime.state);
  const source = state?.phase === "dialog" ? state.source : undefined;
  const underlay = useSourceUrl(source, sourceThumbnailUrl);
  const layerUnderlay = useSourceUrl(source, layerThumbnailUrl);
  const services = useMemo<PropertyServices>(
    () => ({
      resolveImage: (key) => {
        if (key === SOURCE_UNDERLAY_KEY) return underlay;
        if (key === LAYER_UNDERLAY_KEY) return layerUnderlay;
        return undefined;
      },
    }),
    [underlay, layerUnderlay],
  );
  if (state === undefined) return null;
  switch (state.phase) {
    case "dialog": {
      const Custom =
        state.customDialog === undefined ? undefined : CUSTOM_DIALOGS.get(state.customDialog);
      if (Custom !== undefined) {
        return (
          <Custom
            title={state.title}
            schema={state.schema}
            values={state.values}
            source={state.source}
            onValuesChange={(values) => runtime.preview(values)}
            onOk={(values) => runtime.ok(values)}
            onCancel={() => runtime.cancel()}
          />
        );
      }
      return (
        <PropertyDialog
          isOpen
          title={state.title}
          schema={state.schema}
          values={state.values}
          notice={state.notice}
          services={services}
          backdrop="clear"
          onValuesChange={(values) => runtime.preview(values)}
          onOk={(values) => runtime.ok(values)}
          onCancel={() => runtime.cancel()}
        />
      );
    }
    case "rendering":
      return (
        <RenderProgressDialog
          isOpen
          title={state.title}
          percent={state.percent}
          canceling={state.canceling}
          onCancel={() => runtime.cancel()}
        />
      );
    case "error":
      return (
        <EffectErrorDialog
          isOpen
          title={state.title}
          message={state.message}
          details={state.details}
          onViewErrorLog={onViewErrorLog}
          onClose={() => runtime.dismissError()}
        />
      );
  }
}
