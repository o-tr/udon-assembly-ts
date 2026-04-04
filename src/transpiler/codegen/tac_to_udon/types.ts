import {
  ArrayTypeSymbol,
  type TypeSymbol,
} from "../../frontend/type_symbols.js";
import { type TACOperand, TACOperandKind } from "../../ir/tac_operand.js";
import { isKnownExternElementType } from "../udon_type_resolver.js";
import { TACToUdonConverter } from "./converter.js";

export function isFloatType(
  this: TACToUdonConverter,
  typeName: string,
): boolean {
  return typeName === "Single" || typeName === "Double";
}

export function isIntegerType(
  this: TACToUdonConverter,
  typeName: string,
): boolean {
  return (
    typeName === "Byte" ||
    typeName === "SByte" ||
    typeName === "Int16" ||
    typeName === "UInt16" ||
    typeName === "Int32" ||
    typeName === "UInt32" ||
    typeName === "Int64" ||
    typeName === "UInt64"
  );
}

export function isNumericType(
  this: TACToUdonConverter,
  typeName: string,
): boolean {
  return this.isFloatType(typeName) || this.isIntegerType(typeName);
}

// C#/.NET numeric promotion rank (higher = wider).
const NUMERIC_RANK: Record<string, number> = {
  Byte: 1,
  SByte: 1,
  Int16: 2,
  UInt16: 2,
  Int32: 3,
  UInt32: 3,
  Int64: 4,
  UInt64: 4,
  Single: 5,
  Double: 6,
};

// C# promotes all narrow integer arithmetic (byte, sbyte, short, ushort) to int.
// Mixed-sign at the same width follows the same rule for ranks 1–2.
const MIXED_SIGN_PROMOTION: Record<number, string> = {
  1: "Int32", // Byte + SByte → int (C# promotes all narrow types to int)
  2: "Int32", // Int16 + UInt16 → int
  3: "Int64", // Int32 + UInt32 → long
};

/**
 * Returns the promoted type for a binary operation between two numeric types,
 * following C#/.NET implicit numeric promotion rules.
 */
export function getPromotedNumericType(
  this: TACToUdonConverter,
  a: string,
  b: string,
): string {
  const rankA = NUMERIC_RANK[a];
  const rankB = NUMERIC_RANK[b];
  if (rankA === undefined || rankB === undefined) {
    // Caller should ensure both are numeric; return first as no-op fallback
    return a;
  }
  if (rankA === rankB && a !== b) {
    // Same width but different signedness
    // Int64 + UInt64: no lossless integer target in C# (compile error CS0034).
    // Use Double as the widest available type; note precision loss is possible
    // for values beyond ~2^53 (~15.9 decimal digits).
    if (rankA === 4) return "Double";
    return MIXED_SIGN_PROMOTION[rankA] ?? a;
  }
  return rankA >= rankB ? a : b;
}

export function mapUdonTypeToTs(
  this: TACToUdonConverter,
  typeName: string,
): string {
  switch (typeName) {
    case "Byte":
      return "byte";
    case "SByte":
      return "sbyte";
    case "Int16":
      return "short";
    case "UInt16":
      return "ushort";
    case "Int32":
      return "int";
    case "UInt32":
      return "uint";
    case "Int64":
      return "long";
    case "UInt64":
      return "ulong";
    case "Single":
      return "float";
    case "Double":
      return "double";
    case "Boolean":
      return "bool";
    case "String":
      return "string";
    default:
      return "object";
  }
}

export function getOperandTsTypeName(
  this: TACToUdonConverter,
  operand: TACOperand,
): string {
  switch (operand.kind) {
    case TACOperandKind.Variable:
    case TACOperandKind.Constant:
    case TACOperandKind.Temporary: {
      const typeSymbol = (operand as unknown as { type: TypeSymbol }).type;
      if (
        typeSymbol instanceof ArrayTypeSymbol &&
        !isKnownExternElementType(typeSymbol.elementType.name)
      ) {
        return "object[]";
      }
      const tsName = typeSymbol.name ?? "";
      // Defensive: strip trailing [] if a non-ArrayTypeSymbol somehow
      // carries an array-like name (e.g. from a type alias).
      const baseName = tsName.endsWith("[]")
        ? tsName.slice(0, -2)
        : tsName;
      if (!isKnownExternElementType(baseName)) {
        return baseName !== tsName ? "object[]" : "object";
      }
      return tsName;
    }
    default:
      return "object";
  }
}

export function extractInlineClassName(
  this: TACToUdonConverter,
  name: string,
): string | null {
  if (!name.startsWith("__inst_")) {
    return null;
  }
  const rest = name.slice("__inst_".length);
  const parts = rest.split("_").filter((part) => part.length > 0);
  const numericIndex = parts.findIndex((part) =>
    TACToUdonConverter.digitOnlyPattern.test(part),
  );
  if (numericIndex > 0) {
    return parts.slice(0, numericIndex).join("_");
  }
  if (numericIndex === 0) {
    return null;
  }
  return parts.join("_") || null;
}
