import { PrimitiveTypes } from "../../../frontend/type_symbols.js";
import {
  ASTNodeKind,
  type LiteralNode,
  type TemplatePart,
} from "../../../frontend/types.js";
import { type ConstantOperand, createConstant } from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";

export function mergeTemplateParts(
  this: ASTToTACConverter,
  parts: TemplatePart[],
): TemplatePart[] {
  const merged: TemplatePart[] = [];
  let textBuffer = "";
  for (const part of parts) {
    if (part.kind === "text") {
      textBuffer += part.value;
      continue;
    }
    if (textBuffer.length > 0) {
      merged.push({ kind: "text", value: textBuffer });
      textBuffer = "";
    }
    merged.push(part);
  }
  if (textBuffer.length > 0) {
    merged.push({ kind: "text", value: textBuffer });
  }
  return merged;
}

export function tryFoldTemplateExpression(
  this: ASTToTACConverter,
  parts: TemplatePart[],
): ConstantOperand | null {
  let output = "";
  for (const part of parts) {
    if (part.kind === "text") {
      output += part.value;
      continue;
    }
    if (part.expression.kind !== ASTNodeKind.Literal) {
      return null;
    }
    const literal = part.expression as LiteralNode;
    const folded = this.templateLiteralValueToString(literal.value);
    if (folded === null) return null;
    output += folded;
  }
  return createConstant(output, PrimitiveTypes.string);
}

export function templateLiteralValueToString(
  this: ASTToTACConverter,
  value: LiteralNode["value"],
): string | null {
  if (value === null) return "null";
  const valueType = typeof value;
  if (
    valueType === "string" ||
    valueType === "number" ||
    valueType === "boolean" ||
    valueType === "bigint"
  ) {
    return String(value);
  }
  return null;
}
