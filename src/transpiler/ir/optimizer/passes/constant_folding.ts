import type { TypeSymbol } from "../../../frontend/type_symbols.js";
import { PrimitiveTypes } from "../../../frontend/type_symbols.js";
import {
  AssignmentInstruction,
  BinaryOpInstruction,
  type CallInstruction,
  CastInstruction,
  type TACInstruction,
  TACInstructionKind,
  UnaryOpInstruction,
} from "../../tac_instruction.js";
import {
  type ConstantOperand,
  type ConstantValue,
  createConstant,
  type TACOperand,
  TACOperandKind,
  type TemporaryOperand,
} from "../../tac_operand.js";
import type { PassResult } from "../pass_types.js";
import { getDefinedOperandForReuse } from "../utils/instructions.js";
import {
  type PureExternValue,
  pureExternEvaluators,
} from "../utils/pure_extern.js";

/**
 * Constant folding optimization
 * Evaluate constant expressions at compile time
 */
export const constantFolding = (instructions: TACInstruction[]): PassResult => {
  const result: TACInstruction[] = [];
  const temporaryConstants = new Map<number, ConstantOperand>();
  let changed = false;

  const getResolvedConstant = (operand: TACOperand): ConstantOperand | null => {
    if (operand.kind === TACOperandKind.Constant) {
      return operand as ConstantOperand;
    }
    if (operand.kind === TACOperandKind.Temporary) {
      return temporaryConstants.get((operand as TemporaryOperand).id) ?? null;
    }
    return null;
  };

  const trackTemporaryConstant = (
    operand: TACOperand,
    constant: ConstantOperand,
  ): void => {
    if (operand.kind !== TACOperandKind.Temporary) return;
    temporaryConstants.set((operand as TemporaryOperand).id, constant);
  };

  const invalidateDefinedTemporary = (inst: TACInstruction): void => {
    const defined = getDefinedOperandForReuse(inst);
    if (defined?.kind === TACOperandKind.Temporary) {
      temporaryConstants.delete((defined as TemporaryOperand).id);
    }
  };

  const trackFromFoldedAssignment = (inst: TACInstruction): void => {
    if (inst.kind !== TACInstructionKind.Assignment) return;
    const assignment = inst as AssignmentInstruction;
    if (assignment.src.kind !== TACOperandKind.Constant) return;
    trackTemporaryConstant(assignment.dest, assignment.src as ConstantOperand);
  };

  for (const inst of instructions) {
    if (inst.kind === TACInstructionKind.Label) {
      temporaryConstants.clear();
      result.push(inst);
      continue;
    }

    if (
      inst.kind === TACInstructionKind.Assignment ||
      inst.kind === TACInstructionKind.Copy
    ) {
      const assignment = inst as AssignmentInstruction;
      const srcConst = getResolvedConstant(assignment.src);
      if (srcConst) {
        trackTemporaryConstant(assignment.dest, srcConst);
        if (
          inst.kind === TACInstructionKind.Copy ||
          assignment.src !== srcConst
        ) {
          result.push(new AssignmentInstruction(assignment.dest, srcConst));
          changed = true;
        } else {
          result.push(inst);
        }
      } else {
        invalidateDefinedTemporary(inst);
        result.push(inst);
      }
      continue;
    }

    if (inst.kind === TACInstructionKind.Call) {
      const callInst = inst as CallInstruction;
      const pureExternFolded = tryFoldPureExternCall(callInst);
      if (pureExternFolded) {
        result.push(pureExternFolded);
        trackFromFoldedAssignment(pureExternFolded);
        changed = true;
        continue;
      }

      const valueTypeFolded = tryFoldValueTypeConstructor(callInst);
      if (valueTypeFolded) {
        result.push(valueTypeFolded);
        trackFromFoldedAssignment(valueTypeFolded);
        changed = true;
        continue;
      }

      invalidateDefinedTemporary(inst);
      result.push(inst);
      continue;
    }

    if (inst.kind === TACInstructionKind.Cast) {
      const castInst = inst as CastInstruction;
      const srcConst = getResolvedConstant(castInst.src);
      const castInput =
        srcConst && srcConst !== castInst.src
          ? new CastInstruction(castInst.dest, srcConst)
          : castInst;
      const folded = tryFoldCastInstruction(castInput);
      if (folded) {
        result.push(folded);
        trackFromFoldedAssignment(folded);
        changed = true;
        continue;
      }

      invalidateDefinedTemporary(inst);
      if (castInput !== castInst) {
        result.push(castInput);
        changed = true;
      } else {
        result.push(inst);
      }
      continue;
    }

    if (inst.kind === TACInstructionKind.BinaryOp) {
      const binOp = inst as BinaryOpInstruction;
      const leftConst = getResolvedConstant(binOp.left);
      const rightConst = getResolvedConstant(binOp.right);
      const leftOperand = leftConst ?? binOp.left;
      const rightOperand = rightConst ?? binOp.right;

      // Check if both operands are constants (including constants coming from folded temporaries)
      if (leftConst && rightConst) {
        if (
          leftConst.value === null ||
          rightConst.value === null ||
          !isPrimitiveFoldValue(leftConst.value) ||
          !isPrimitiveFoldValue(rightConst.value)
        ) {
          invalidateDefinedTemporary(inst);
          result.push(inst);
          continue;
        }

        // For bitwise ops, only fold for 32-bit integer types (JS bitwise semantics truncate to int32)
        if (
          (binOp.operator === "<<" ||
            binOp.operator === ">>" ||
            binOp.operator === "&" ||
            binOp.operator === "|" ||
            binOp.operator === "^") &&
          leftConst.type &&
          leftConst.type.udonType !== "Int32" &&
          leftConst.type.udonType !== "UInt32"
        ) {
          invalidateDefinedTemporary(inst);
          result.push(inst);
          continue;
        }

        // Evaluate the operation
        const foldedValue = evaluateBinaryOp(
          leftConst.value,
          binOp.operator,
          rightConst.value,
        );

        if (foldedValue !== null) {
          // Replace with assignment of constant
          const foldedType = [
            "+",
            "-",
            "*",
            "/",
            "<<",
            ">>",
            "&",
            "|",
            "^",
            "%",
          ].includes(binOp.operator)
            ? leftConst.type
            : PrimitiveTypes.boolean;
          const constantOperand = createConstant(foldedValue, foldedType);
          trackTemporaryConstant(binOp.dest, constantOperand);
          result.push(new AssignmentInstruction(binOp.dest, constantOperand));
          changed = true;
          continue;
        }
      }

      invalidateDefinedTemporary(inst);
      if (leftOperand !== binOp.left || rightOperand !== binOp.right) {
        result.push(
          new BinaryOpInstruction(
            binOp.dest,
            leftOperand,
            binOp.operator,
            rightOperand,
          ),
        );
        changed = true;
      } else {
        result.push(inst);
      }
      continue;
    }

    if (inst.kind === TACInstructionKind.UnaryOp) {
      const unOp = inst as UnaryOpInstruction;
      const constOp = getResolvedConstant(unOp.operand);
      const operand = constOp ?? unOp.operand;

      // Check if operand is constant (including constants coming from folded temporaries)
      if (constOp) {
        if (constOp.value === null || !isPrimitiveFoldValue(constOp.value)) {
          invalidateDefinedTemporary(inst);
          result.push(inst);
          continue;
        }

        // Evaluate the operation
        const foldedValue = evaluateUnaryOp(unOp.operator, constOp.value);

        if (foldedValue !== null) {
          // Replace with assignment of constant
          const constantOperand = createConstant(foldedValue, constOp.type);
          trackTemporaryConstant(unOp.dest, constantOperand);
          result.push(new AssignmentInstruction(unOp.dest, constantOperand));
          changed = true;
          continue;
        }
      }

      invalidateDefinedTemporary(inst);
      if (operand !== unOp.operand) {
        result.push(new UnaryOpInstruction(unOp.dest, unOp.operator, operand));
        changed = true;
      } else {
        result.push(inst);
      }
      continue;
    }

    invalidateDefinedTemporary(inst);
    // Keep instruction as-is
    result.push(inst);
  }

  return { instructions: changed ? result : instructions, changed };
};

export const tryFoldCastInstruction = (
  inst: CastInstruction,
): TACInstruction | null => {
  if (inst.src.kind !== TACOperandKind.Constant) return null;
  const srcConst = inst.src as ConstantOperand;
  if (srcConst.value === null || !isPrimitiveFoldValue(srcConst.value)) {
    return null;
  }

  const destType = getOperandType(inst.dest);
  const castValue = evaluateCastValue(srcConst.value, destType);
  if (castValue === null) return null;

  return new AssignmentInstruction(
    inst.dest,
    createConstant(castValue, destType),
  );
};

export const tryFoldValueTypeConstructor = (
  inst: CallInstruction,
): TACInstruction | null => {
  if (!inst.dest) return null;
  if (inst.func !== "__ctor_Vector3" && inst.func !== "__ctor_Color") {
    return null;
  }
  if (inst.args.length === 0) return null;

  const numericArgs: number[] = [];
  for (const arg of inst.args) {
    if (arg.kind !== TACOperandKind.Constant) return null;
    const constArg = arg as ConstantOperand;
    if (typeof constArg.value !== "number") return null;
    numericArgs.push(constArg.value);
  }

  let foldedValue: Record<string, number> | null = null;
  if (inst.func === "__ctor_Vector3") {
    if (numericArgs.length !== 3) return null;
    foldedValue = {
      x: numericArgs[0],
      y: numericArgs[1],
      z: numericArgs[2],
    };
  }

  if (inst.func === "__ctor_Color") {
    if (numericArgs.length < 3) return null;
    foldedValue = {
      r: numericArgs[0],
      g: numericArgs[1],
      b: numericArgs[2],
      a: numericArgs[3] ?? 1,
    };
  }

  if (!foldedValue) return null;
  const destType = getOperandType(inst.dest);
  return new AssignmentInstruction(
    inst.dest,
    createConstant(foldedValue, destType),
  );
};

export const tryFoldPureExternCall = (
  inst: CallInstruction,
): TACInstruction | null => {
  if (!inst.dest) return null;
  const evaluator = pureExternEvaluators.get(inst.func);
  if (!evaluator) return null;
  if (inst.args.length !== evaluator.arity) return null;

  const args: PureExternValue[] = [];
  for (const arg of inst.args) {
    if (arg.kind !== TACOperandKind.Constant) return null;
    const constArg = arg as ConstantOperand;
    if (constArg.value === null) return null;
    if (typeof constArg.value === "number") {
      if (!Number.isFinite(constArg.value)) return null;
      args.push(constArg.value);
      continue;
    }
    if (typeof constArg.value === "string") {
      args.push(constArg.value);
      continue;
    }
    if (typeof constArg.value === "object" && !Array.isArray(constArg.value)) {
      const value = constArg.value as Record<string, number>;
      if (
        typeof value.x === "number" &&
        typeof value.y === "number" &&
        typeof value.z === "number"
      ) {
        args.push(value as PureExternValue);
        continue;
      }
    }
    return null;
  }

  const result = evaluator.eval(args);
  if (result === null) return null;
  if (typeof result === "number" && !Number.isFinite(result)) return null;

  const destType = getOperandType(inst.dest);
  const casted = evaluateCastValue(result, destType);
  if (casted === null) return null;
  if (typeof casted === "number" && !Number.isFinite(casted)) return null;

  return new AssignmentInstruction(inst.dest, createConstant(casted, destType));
};

/**
 * Evaluate binary operation on constants
 */
export const evaluateBinaryOp = (
  left: number | string | boolean | bigint,
  operator: string,
  right: number | string | boolean | bigint,
): number | boolean | string | null => {
  if (typeof left === "string" && typeof right === "string") {
    if (operator === "+") return left + right;
    if (operator === "==") return left === right;
    if (operator === "!=") return left !== right;
  }

  if (typeof left === "boolean" && typeof right === "boolean") {
    if (operator === "&&") return left && right;
    if (operator === "||") return left || right;
    if (operator === "==") return left === right;
    if (operator === "!=") return left !== right;
  }

  if (typeof left === "number" && typeof right === "number") {
    switch (operator) {
      case "+":
        return Number.isFinite(left + right) ? left + right : null;
      case "-":
        return Number.isFinite(left - right) ? left - right : null;
      case "*":
        return Number.isFinite(left * right) ? left * right : null;
      case "/":
        return Number.isFinite(left / right) ? left / right : null;
      case "<<":
        return (left | 0) << ((right >>> 0) & 31);
      case ">>":
        return (left | 0) >> ((right >>> 0) & 31);
      case "&":
        return left & right;
      case "|":
        return left | right;
      case "^":
        return left ^ right;
      case "%":
        return Number.isFinite(left % right) ? left % right : null;
      case "<":
        return left < right;
      case ">":
        return left > right;
      case "<=":
        return left <= right;
      case ">=":
        return left >= right;
      case "==":
        return left === right;
      case "!=":
        return left !== right;
      default:
        return null;
    }
  }

  const isNumericLike = (
    value: number | string | boolean | bigint,
  ): value is number | boolean =>
    typeof value === "number" || typeof value === "boolean";

  if (isNumericLike(left) && isNumericLike(right)) {
    const leftNum = typeof left === "number" ? left : left ? 1 : 0;
    const rightNum = typeof right === "number" ? right : right ? 1 : 0;
    if (operator === "<") return leftNum < rightNum;
    if (operator === ">") return leftNum > rightNum;
    if (operator === "<=") return leftNum <= rightNum;
    if (operator === ">=") return leftNum >= rightNum;
    if (operator === "==") return leftNum === rightNum;
    if (operator === "!=") return leftNum !== rightNum;
  }

  return null;
};

/**
 * Evaluate unary operation on constant
 */
export const evaluateUnaryOp = (
  operator: string,
  operand: number | string | boolean | bigint,
): number | boolean | bigint | null => {
  if (operator === "-" && typeof operand === "number") {
    return -operand;
  }
  if (operator === "!" && typeof operand === "boolean") {
    return !operand;
  }
  if (operator === "~") {
    if (typeof operand === "number") {
      return ~operand;
    }
    if (typeof operand === "bigint") {
      return ~operand;
    }
  }
  return null;
};

export const evaluateCastValue = (
  value: number | string | boolean | bigint,
  targetType: TypeSymbol,
): number | string | boolean | bigint | null => {
  const target = targetType.udonType;

  if (target === "Boolean") {
    return Boolean(value);
  }

  if (target === "String") {
    return String(value);
  }

  if (target === "Int64" || target === "UInt64") {
    try {
      if (typeof value === "bigint") return value;
      if (typeof value === "number") return BigInt(Math.trunc(value));
      if (typeof value === "boolean") return value ? 1n : 0n;
      if (typeof value === "string") return BigInt(value);
    } catch {
      return null;
    }
  }

  if (isNumericUdonType(target)) {
    let numeric: number;
    if (typeof value === "number") {
      numeric = value;
    } else if (typeof value === "boolean") {
      numeric = value ? 1 : 0;
    } else if (typeof value === "string") {
      numeric = Number(value);
    } else if (typeof value === "bigint") {
      numeric = Number(value);
    } else {
      return null;
    }

    if (Number.isNaN(numeric)) return null;

    if (isIntegerUdonType(target)) {
      if (target === "UInt32") {
        return numeric >>> 0;
      }
      return Math.trunc(numeric);
    }

    return numeric;
  }

  return null;
};

export const getOperandType = (operand: TACOperand): TypeSymbol => {
  if (
    operand.kind === TACOperandKind.Variable ||
    operand.kind === TACOperandKind.Constant ||
    operand.kind === TACOperandKind.Temporary
  ) {
    return (operand as unknown as { type: TypeSymbol }).type;
  }
  return PrimitiveTypes.single;
};

export const isNumericUdonType = (typeName: string): boolean => {
  return isIntegerUdonType(typeName) || isFloatUdonType(typeName);
};

export const isFloatUdonType = (typeName: string): boolean => {
  return typeName === "Single" || typeName === "Double";
};

export const isIntegerUdonType = (typeName: string): boolean => {
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
};

export const isPrimitiveFoldValue = (
  value: ConstantValue,
): value is number | string | boolean | bigint => {
  const type = typeof value;
  return (
    type === "number" ||
    type === "string" ||
    type === "boolean" ||
    type === "bigint"
  );
};
