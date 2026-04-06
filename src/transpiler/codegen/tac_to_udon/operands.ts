import {
  ArrayTypeSymbol,
  type TypeSymbol,
} from "../../frontend/type_symbols.js";
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

export function pushOperand(
  this: TACToUdonConverter,
  operand: TACOperand,
): void {
  const addr = this.getOperandAddress(operand);
  this.instructions.push(new PushInstruction(addr));
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
        this.variableTypes.set(normalizedName, varOp.type.udonType);
      }
      // Return the variable name for use in PUSH instruction
      return normalizedName;
    }

    case TACOperandKind.Temporary: {
      const tempOp = operand as TemporaryOperand;
      if (!this.tempAddresses.has(tempOp.id)) {
        this.tempAddresses.set(tempOp.id, this.nextAddress++);
        this.tempTypes.set(tempOp.id, tempOp.type.udonType);
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
        this.constantTypes.set(key, constOp.type.udonType);
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
      // All TypeScript arrays are backed by DataList at runtime.
      // Native SystemArray EXTERNs (Get/Set) are not supported by Udon VM.
      if (typeSymbol instanceof ArrayTypeSymbol) {
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
