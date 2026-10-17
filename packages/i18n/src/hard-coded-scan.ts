import { parse } from "@babel/parser";

/** A string literal that a user can read but that does not come from the message catalog. */
export interface HardCodedString {
  line: number;
  text: string;
}

/** JSX attributes whose values are shown to the user or read by assistive technology. */
const USER_VISIBLE_ATTRIBUTES = new Set([
  "alt",
  "aria-description",
  "aria-label",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "label",
  "placeholder",
  "title",
]);

/** Object properties that hold display text, such as menu and control definitions. */
const USER_VISIBLE_PROPERTIES = new Set([
  "description",
  "label",
  "message",
  "placeholder",
  "text",
  "title",
  "tooltip",
]);

const LETTER = /\p{L}/u;
const SKIPPED_KEYS = new Set([
  "comments",
  "end",
  "extra",
  "leadingComments",
  "loc",
  "start",
  "trailingComments",
]);

interface AstNode {
  type: string;
  loc?: { start: { line: number } };
  [key: string]: unknown;
}

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

/** The text of a string or template literal with no interpolation, otherwise undefined. */
function literalText(node: unknown): string | undefined {
  if (!isNode(node)) {
    return undefined;
  }
  if (node.type === "StringLiteral") {
    return node.value as string;
  }
  if (node.type === "TemplateLiteral") {
    const quasis = node.quasis as { value: { cooked: string | null } }[];
    return quasis.map((quasi) => quasi.value.cooked ?? "").join("");
  }
  return undefined;
}

/** A JSX child or attribute value of the form `{"text"}`. */
function expressionText(node: unknown): string | undefined {
  if (isNode(node) && node.type === "JSXExpressionContainer") {
    return literalText(node.expression);
  }
  return undefined;
}

/**
 * Finds user-visible text written directly in source instead of the message catalog: JSX text,
 * the attributes in `USER_VISIBLE_ATTRIBUTES`, `{"text"}` children, and display properties in
 * `USER_VISIBLE_PROPERTIES`. A value counts only if it contains a letter, so punctuation and
 * whitespace pass.
 */
export function findHardCodedStrings(source: string, fileName: string): HardCodedString[] {
  const isJsx = fileName.endsWith(".tsx");
  const ast = parse(source, {
    sourceType: "module",
    sourceFilename: fileName,
    plugins: isJsx ? ["jsx", "typescript"] : ["typescript"],
  });
  const found: HardCodedString[] = [];

  const report = (node: AstNode, text: string | undefined) => {
    if (text !== undefined && LETTER.test(text)) {
      found.push({ line: node.loc?.start.line ?? 0, text: text.trim() });
    }
  };

  const visit = (node: AstNode) => {
    switch (node.type) {
      case "JSXText":
        report(node, node.value as string);
        break;
      case "JSXElement":
      case "JSXFragment":
        for (const child of node.children as unknown[]) {
          if (isNode(child) && child.type === "JSXExpressionContainer") {
            report(child, expressionText(child));
          }
        }
        break;
      case "JSXAttribute": {
        const name = isNode(node.name) ? node.name.name : undefined;
        if (typeof name === "string" && USER_VISIBLE_ATTRIBUTES.has(name)) {
          report(node, literalText(node.value) ?? expressionText(node.value));
        }
        break;
      }
      case "ObjectProperty": {
        const key = isNode(node.key) ? node.key.name : undefined;
        if (!node.computed && typeof key === "string" && USER_VISIBLE_PROPERTIES.has(key)) {
          report(node, literalText(node.value));
        }
        break;
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (SKIPPED_KEYS.has(key)) {
        continue;
      }
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isNode(child)) {
          visit(child);
        }
      }
    }
  };

  visit(ast.program as unknown as AstNode);
  return found;
}
