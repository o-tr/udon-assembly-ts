import { resolveExternSignature } from "../extern_signatures.js";
import { createUdonExternSignature } from "../udon_instruction.js";
import type { TACToUdonConverter } from "./converter.js";

export function getExternSymbol(
  this: TACToUdonConverter,
  signature: string
): string {
  const existing = this.externSymbolBySignature.get(signature);
  if (existing) return existing;
  const symbol = `__extern_${this.nextExternId++}`;
  this.externSymbolBySignature.set(signature, symbol);
  this.externAddressBySignature.set(signature, this.nextAddress++);
  return symbol;
}

export function getExternForBinaryOp(
  this: TACToUdonConverter,
  operator: string, typeStr: string
): string {
  let methodName: string;
  let returnType = typeStr;

  switch (operator) {
    case "+":
      methodName = "op_Addition";
      break;
    case "-":
      methodName = "op_Subtraction";
      break;
    case "*":
      methodName = "op_Multiply";
      break;
    case "/":
      methodName = "op_Division";
      break;
    case "%":
      methodName = "op_Remainder";
      break;
    case "<":
      methodName = "op_LessThan";
      returnType = "Boolean";
      break;
    case ">":
      methodName = "op_GreaterThan";
      returnType = "Boolean";
      break;
    case "<=":
      methodName = "op_LessThanOrEqual";
      returnType = "Boolean";
      break;
    case ">=":
      methodName = "op_GreaterThanOrEqual";
      returnType = "Boolean";
      break;
    case "==":
      methodName = "op_Equality";
      returnType = "Boolean";
      break;
    case "!=":
      methodName = "op_Inequality";
      returnType = "Boolean";
      break;
    case "&":
      methodName = "op_LogicalAnd";
      break;
    case "|":
      methodName = "op_LogicalOr";
      break;
    case "^":
      methodName = "op_LogicalXor";
      break;
    case "<<":
      methodName = "op_LeftShift";
      break;
    case ">>":
      methodName = "op_RightShift";
      break;
    default:
      throw new Error(`Unsupported binary operator: ${operator}`);
  }

  return createUdonExternSignature(
    methodName,
    [typeStr, typeStr],
    returnType,
  );
}

export function getExternForUnaryOp(
  this: TACToUdonConverter,
  operator: string, operandType: string
): string {
  let methodName: string;

  switch (operator) {
    case "-":
      methodName = "op_UnaryMinus";
      break;
    case "!":
      methodName = "op_UnaryNegation";
      operandType = "Boolean"; // ! operator is always on Boolean
      break;
    default:
      throw new Error(`Unsupported unary operator: ${operator}`);
  }

  return createUdonExternSignature(methodName, [operandType], operandType);
}

export function getConvertExternSignature(
  this: TACToUdonConverter,
  sourceType: string,
  targetType: string,
): string {
  const method = this.getConvertMethodName(targetType);
  const sourceTs = this.mapUdonTypeToTs(sourceType);
  const targetTs = this.mapUdonTypeToTs(targetType);
  const externSig = resolveExternSignature(
    "Convert",
    method,
    "method",
    [sourceTs],
    targetTs,
  );
  if (!externSig) {
    throw new Error(`Missing extern signature for Convert.${method}`);
  }
  return externSig;
}

export function getConvertMethodName(
  this: TACToUdonConverter,
  targetType: string
): string {
  switch (targetType) {
    case "Int16":
      return "ToInt16";
    case "UInt16":
      return "ToUInt16";
    case "Int32":
      return "ToInt32";
    case "UInt32":
      return "ToUInt32";
    case "Int64":
      return "ToInt64";
    case "UInt64":
      return "ToUInt64";
    case "Single":
      return "ToSingle";
    case "Double":
      return "ToDouble";
    case "Boolean":
      return "ToBoolean";
    default:
      throw new Error(`Unsupported cast target type: ${targetType}`);
  }
}

export function getTruncateExternSignature(
  this: TACToUdonConverter,
): string {
  const externSig = resolveExternSignature(
    "SystemMath",
    "Truncate",
    "method",
    ["double"],
    "double",
  );
  if (!externSig) {
    throw new Error("Missing extern signature for Math.Truncate");
  }
  return externSig;
}
