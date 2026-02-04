/**
 * TAC (Three-Address Code) operand types
 */

import type { TypeSymbol } from "../frontend/type_symbols.js";

/**
 * TAC operand kinds
 */
export enum TACOperandKind {
  Variable = "Variable",
  Constant = "Constant",
  Temporary = "Temporary",
  Label = "Label",
}

export type ConstantValue =
  | number
  | string
  | boolean
  | bigint
  | null
  | Record<string, number>
  | number[];

/**
 * Base TAC operand interface
 */
export interface TACOperand {
  kind: TACOperandKind;
}

/**
 * Variable operand
 */
export interface VariableOperand extends TACOperand {
  kind: TACOperandKind.Variable;
  name: string;
  type: TypeSymbol;
  isLocal?: boolean;
  isParameter?: boolean;
  isExported?: boolean;
}

/**
 * Constant operand
 */
export interface ConstantOperand extends TACOperand {
  kind: TACOperandKind.Constant;
  value: ConstantValue;
  type: TypeSymbol;
}

/**
 * Temporary variable operand
 */
export interface TemporaryOperand extends TACOperand {
  kind: TACOperandKind.Temporary;
  id: number;
  type: TypeSymbol;
}

/**
 * Label operand (for jumps)
 */
export interface LabelOperand extends TACOperand {
  kind: TACOperandKind.Label;
  name: string;
}

/**
 * Helper functions to create operands
 */
export function createVariable(
  name: string,
  type: TypeSymbol,
  metadata?: {
    isLocal?: boolean;
    isParameter?: boolean;
    isExported?: boolean;
  },
): VariableOperand {
  return {
    kind: TACOperandKind.Variable,
    name,
    type,
    ...metadata,
  };
}

export function createConstant(
  value: ConstantValue,
  type: TypeSymbol,
): ConstantOperand {
  return {
    kind: TACOperandKind.Constant,
    value,
    type,
  };
}

export function createTemporary(
  id: number,
  type: TypeSymbol,
): TemporaryOperand {
  return {
    kind: TACOperandKind.Temporary,
    id,
    type,
  };
}

export function createLabel(name: string): LabelOperand {
  return {
    kind: TACOperandKind.Label,
    name,
  };
}

/**
 * Convert operand to string for display
 */
export function operandToString(operand: TACOperand): string {
  switch (operand.kind) {
    case TACOperandKind.Variable:
      return (operand as VariableOperand).name;
    case TACOperandKind.Constant: {
      const constOp = operand as ConstantOperand;
      if (typeof constOp.value === "string") {
        return `"${constOp.value}"`;
      }
      if (typeof constOp.value === "object") {
        return JSON.stringify(constOp.value);
      }
      return String(constOp.value);
    }
    case TACOperandKind.Temporary:
      return `t${(operand as TemporaryOperand).id}`;
    case TACOperandKind.Label:
      return (operand as LabelOperand).name;
  }
}
