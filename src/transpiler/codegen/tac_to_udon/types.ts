import { type TACOperand, TACOperandKind } from "../../ir/tac_operand.js";
import { TACToUdonConverter } from "./converter.js";

export function isFloatType(
  this: TACToUdonConverter,
  typeName: string
): boolean {
  return typeName === "Single" || typeName === "Double";
}

export function isIntegerType(
  this: TACToUdonConverter,
  typeName: string
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

export function mapUdonTypeToTs(
  this: TACToUdonConverter,
  typeName: string
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
  operand: TACOperand
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
  name: string
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
