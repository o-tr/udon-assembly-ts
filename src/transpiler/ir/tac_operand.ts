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

/** Prefix impossible in normal TypeScript identifiers (U+E000 PUA). */
const SCCP_TEMP_LATTICE_PREFIX = "\uE000";

/**
 * Stable key for SCCP / optimizer lattice maps for temporaries.
 * Disjoint from user source names (including `__sccp_tmp_<n>`) and from
 * {@link operandToString} display (`t0`).
 */
export function temporaryLatticeKey(id: number): string {
  return `${SCCP_TEMP_LATTICE_PREFIX}sccp_tmp_${id}`;
}

/** Inverse of {@link temporaryLatticeKey} for lattice slot names; otherwise null. */
export function parseTemporaryLatticeKey(name: string): number | null {
  if (!name.startsWith(SCCP_TEMP_LATTICE_PREFIX)) return null;
  const rest = name.slice(SCCP_TEMP_LATTICE_PREFIX.length);
  const m = /^sccp_tmp_(\d+)$/.exec(rest);
  return m ? Number(m[1]) : null;
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
