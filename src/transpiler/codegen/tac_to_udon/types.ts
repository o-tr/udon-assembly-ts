import { type TACOperand, TACOperandKind } from "../../ir/tac_operand.js";
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

// When signed + unsigned at the same width, C# promotes to the next wider
// signed type (except Int64 + UInt64 → UInt64).
const MIXED_SIGN_PROMOTION: Record<number, string> = {
  1: "Int16", // Byte + SByte
  2: "Int32", // Int16 + UInt16
  3: "Int64", // Int32 + UInt32
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
    if (rankA === 4) return "Double"; // Int64 + UInt64: no lossless integer target; use Double
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
      const typeName =
        (operand as { type?: { name?: string } }).type?.name ?? "object";
      return typeName;
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
