import {
  ArrayTypeSymbol,
  type TypeSymbol,
} from "../../frontend/type_symbols.js";
import { UdonType } from "../../frontend/types.js";
import {
  type ConstantOperand,
  type LabelOperand,
  type TACOperand,
  TACOperandKind,
  type TemporaryOperand,
  type VariableOperand,
} from "../../ir/tac_operand.js";
import { PushInstruction } from "../udon_instruction.js";
import {
  toUdonTypeNameWithArray,
  udonTypeToCSharp,
} from "../udon_type_resolver.js";
import type { TACToUdonConverter } from "./converter.js";

/**
 * Resolve the heap type name for a TypeSymbol.
 * ArrayTypeSymbol uses DataList in Udon, not the raw "Array" udonType.
 */
function resolveHeapType(typeSymbol: TypeSymbol): string {
  if (
    typeSymbol instanceof ArrayTypeSymbol ||
    (typeSymbol.name ?? "").endsWith("[]")
  ) {
    return UdonType.DataList;
  }
  return typeSymbol.udonType;
}

export function pushOperand(
  this: TACToUdonConverter,
  operand: TACOperand,
): void {
  const addr = this.getOperandAddress(operand);
  this.instructions.push(new PushInstruction(addr));
}

/**
 * Allocate a primitive constant on the heap (if not already present) and push it.
 * @param value - The constant value (number, boolean, string, etc.)
 * @param typeName - The Udon type name (e.g. "Int32", "Boolean")
 */
export function pushConstant(
  this: TACToUdonConverter,
  value: unknown,
  typeName: string,
): void {
  const key = this.getConstantKey(value, typeName);
  if (!this.constantAddresses.has(key)) {
    const addr = this.nextAddress++;
    this.constantAddresses.set(key, addr);
    this.constantTypes.set(key, typeName);
  }
  const addr = this.constantAddresses.get(key) as number;
  const name = `__const_${addr}_System${typeName}`;
  this.instructions.push(new PushInstruction(name));
}

export function getOperandAddress(
  this: TACToUdonConverter,
  operand: TACOperand,
): number | string {
  switch (operand.kind) {
    case TACOperandKind.Variable: {
      const varOp = operand as VariableOperand;
      const normalizedName = this.normalizeVariableName(varOp.name);
      if (!this.variableAddresses.has(normalizedName)) {
        this.variableAddresses.set(normalizedName, this.nextAddress++);
        this.variableTypes.set(normalizedName, resolveHeapType(varOp.type));
      }
      // Return the variable name for use in PUSH instruction
      return normalizedName;
    }

    case TACOperandKind.Temporary: {
      const tempOp = operand as TemporaryOperand;
      if (!this.tempAddresses.has(tempOp.id)) {
        this.tempAddresses.set(tempOp.id, this.nextAddress++);
        this.tempTypes.set(tempOp.id, resolveHeapType(tempOp.type));
      }
      // Return the temporary name for use in PUSH instruction
      return `__t${tempOp.id}`;
    }

    case TACOperandKind.Constant: {
      const constOp = operand as ConstantOperand;
      const key = this.getConstantKey(constOp.value, constOp.type.udonType);
      if (!this.constantAddresses.has(key)) {
        const addr = this.nextAddress++;
        this.constantAddresses.set(key, addr);
        this.constantTypes.set(key, resolveHeapType(constOp.type));
      }
      // Return the constant variable name for use in PUSH instruction
      const addr = this.constantAddresses.get(key) as number;
      const type = this.constantTypes.get(key) ?? "Single";
      return `__const_${addr}_System${type}`;
    }

    case TACOperandKind.Label: {
      const labelOp = operand as LabelOperand;
      return labelOp.name;
    }

    default:
      throw new Error(`Unknown operand kind: ${operand.kind}`);
  }
}

export function getOperandTypeName(
  this: TACToUdonConverter,
  operand: TACOperand,
): string {
  switch (operand.kind) {
    case TACOperandKind.Variable:
    case TACOperandKind.Constant:
    case TACOperandKind.Temporary: {
      const typeSymbol = (operand as unknown as { type: TypeSymbol }).type;
      // Current lowering policy represents TypeScript arrays as DataList in
      // generated UASM, even though native typed arrays exist in Udon.
      if (
        typeSymbol instanceof ArrayTypeSymbol ||
        (typeSymbol.name ?? "").endsWith("[]")
      ) {
        return "VRCSDK3DataDataList";
      }
      return toUdonTypeNameWithArray(udonTypeToCSharp(typeSymbol.udonType));
    }
    default:
      return "SystemObject";
  }
}

export function getOperandUdonType(
  this: TACToUdonConverter,
  operand: TACOperand,
): string {
  switch (operand.kind) {
    case TACOperandKind.Variable:
    case TACOperandKind.Constant:
    case TACOperandKind.Temporary:
      // type is always present on Variable/Constant/Temporary operands (required in their interfaces)
      return (operand as unknown as { type: TypeSymbol }).type.udonType;
    default:
      return "Object";
  }
}

export function normalizeVariableName(
  this: TACToUdonConverter,
  name: string,
): string {
  if (name === "this") {
    return "__this";
  }
  return name;
}

export function getReturnValueAddress(
  this: TACToUdonConverter,
  name: string,
): void {
  const normalizedName = this.normalizeVariableName(name);
  if (!this.variableAddresses.has(normalizedName)) {
    this.variableAddresses.set(normalizedName, this.nextAddress++);
    this.variableTypes.set(normalizedName, "Object");
  }
}
