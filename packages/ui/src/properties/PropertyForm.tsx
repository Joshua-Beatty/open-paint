import { useTranslation } from "@openpaint/i18n/react";
import {
  type LayoutNode,
  layoutOf,
  type PropertyCollection,
  PropertyValidationError,
  type PropertyValue,
} from "@openpaint/properties";
import { memo, useCallback, useEffect, useReducer } from "react";
import { Tab, TabList, TabPanel, Tabs } from "react-aria-components";
import { FormNameContext, PropertyControl } from "./controls";
import { type ControlLayout, ControlLayoutContext } from "./layout-context";
import type { PropertyServices } from "./services";
import "./controls.css";
import "./property-dialog.css";

export interface PropertyFormProps {
  /** The live values, rules and read-only flags that the controls edit. */
  readonly collection: PropertyCollection;
  readonly services?: PropertyServices;
  /** The dialog's name, which names any control whose caption is blank. */
  readonly label?: string;
  /** Stacked (dialogs, settings) or inline (one toolbar row). Defaults to stacked. */
  readonly layout?: ControlLayout;
}

/**
 * Renders a collection's layout (EXT-06C-03): controls stacked vertically, panels and tab
 * containers, or in the inline layout one compact item per control. Changes to values and
 * read-only flags re-render the form, so rules show at once.
 */
/** The services of a form given none, one object so memoized controls see no change. */
const NO_SERVICES: PropertyServices = {};

export function PropertyForm({
  collection,
  services = NO_SERVICES,
  label = "",
  layout = "stacked",
}: PropertyFormProps) {
  useCollectionChanges(collection);
  return (
    <ControlLayoutContext.Provider value={layout}>
      <FormNameContext.Provider value={label}>
        <div className={layout === "inline" ? "prop-form is-inline" : "prop-form"}>
          {layoutOf(collection.schema).map((node, index) => (
            <LayoutNodeView
              key={nodeKey(node, index)}
              node={node}
              collection={collection}
              services={services}
            />
          ))}
        </div>
      </FormNameContext.Provider>
    </ControlLayoutContext.Provider>
  );
}

function nodeKey(node: LayoutNode, index: number): string {
  if (node.kind === "control") return `control:${node.key}`;
  return `${node.kind}:${index}`;
}

function useCollectionChanges(collection: PropertyCollection): void {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    const stopValues = collection.on("valueChanged", () => rerender());
    const stopReadOnly = collection.on("readOnlyChanged", () => rerender());
    return () => {
      stopValues();
      stopReadOnly();
    };
  }, [collection]);
}

/**
 * Writes a value through the property's policy. A `reject` property throws on an invalid value,
 * which the form treats as a refused edit: the value stays as it was.
 */
export function assignValue(collection: PropertyCollection, key: string, value: unknown): void {
  try {
    collection.set(key, value);
  } catch (error) {
    if (!(error instanceof PropertyValidationError)) throw error;
  }
}

interface FormNodeProps {
  readonly collection: PropertyCollection;
  readonly services: PropertyServices;
}

function LayoutNodeView({
  node,
  collection,
  services,
}: FormNodeProps & { readonly node: LayoutNode }) {
  switch (node.kind) {
    case "control":
      return <ControlNode collection={collection} propertyKey={node.key} services={services} />;
    case "panel":
      return (
        <div className="prop-panel">
          {node.children.map((child, index) => (
            <LayoutNodeView
              key={nodeKey(child, index)}
              node={child}
              collection={collection}
              services={services}
            />
          ))}
        </div>
      );
    case "tabs":
      return <TabsNode node={node} collection={collection} services={services} />;
  }
}

function ControlNode({
  collection,
  propertyKey,
  services,
}: FormNodeProps & { readonly propertyKey: string }) {
  const value: PropertyValue = collection.get(propertyKey);
  const onChange = useCallback(
    (next: PropertyValue) => assignValue(collection, propertyKey, next),
    [collection, propertyKey],
  );
  // The form re-renders on every value change; memoized controls whose props are unchanged skip
  // it, so dragging one slider re-renders only that control (L3).
  return (
    <MemoPropertyControl
      definition={collection.definition(propertyKey)}
      value={value}
      readOnly={collection.isReadOnly(propertyKey)}
      services={services}
      onChange={onChange}
    />
  );
}

const MemoPropertyControl = memo(PropertyControl);

function TabsNode({
  node,
  collection,
  services,
}: FormNodeProps & { readonly node: Extract<LayoutNode, { kind: "tabs" }> }) {
  const t = useTranslation();
  const selected = collection.get(node.key);
  return (
    <Tabs
      className="prop-tabs"
      selectedKey={String(selected)}
      onSelectionChange={(key) => assignValue(collection, node.key, Number(key))}
    >
      <TabList className="prop-tab-list" aria-label={t(collection.definition(node.key).label)}>
        {node.pages.map((page, index) => (
          <Tab key={String(index)} id={String(index)}>
            {t(page.label)}
          </Tab>
        ))}
      </TabList>
      {node.pages.map((page, index) => (
        <TabPanel key={String(index)} id={String(index)} className="prop-tab-panel">
          {page.children.map((child, childIndex) => (
            <LayoutNodeView
              key={nodeKey(child, childIndex)}
              node={child}
              collection={collection}
              services={services}
            />
          ))}
        </TabPanel>
      ))}
    </Tabs>
  );
}
