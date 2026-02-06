import {
  type ArrayAccessInstruction,
  type ArrayAssignmentInstruction,
  AssignmentInstruction,
  BinaryOpInstruction,
  CallInstruction,
  CastInstruction,
  type ConditionalJumpInstruction,
  MethodCallInstruction,
  type PhiInstruction,
  type PropertyGetInstruction,
  type PropertySetInstruction,
  type ReturnInstruction,
  type TACInstruction,
  TACInstructionKind,
  UnaryOpInstruction,
} from "../../tac_instruction.js";
import type { TACOperand, TemporaryOperand } from "../../tac_operand.js";
import { TACOperandKind } from "../../tac_operand.js";

export type InstWithDestSrc = { dest: TACOperand; src: TACOperand };
export type InstWithDest = { dest: TACOperand };

export const getUsedOperandsForReuse = (inst: TACInstruction): TACOperand[] => {
  switch (inst.kind) {
    case TACInstructionKind.Assignment:
    case TACInstructionKind.Copy:
    case TACInstructionKind.Cast:
      return [(inst as unknown as InstWithDestSrc).src];
    case TACInstructionKind.BinaryOp: {
      const bin = inst as BinaryOpInstruction;
      return [bin.left, bin.right];
    }
    case TACInstructionKind.UnaryOp:
      return [(inst as UnaryOpInstruction).operand];
    case TACInstructionKind.ConditionalJump:
      return [(inst as unknown as ConditionalJumpInstruction).condition];
    case TACInstructionKind.Call:
      return (inst as unknown as CallInstruction).args ?? [];
    case TACInstructionKind.MethodCall: {
      const method = inst as unknown as MethodCallInstruction;
      return [method.object, ...(method.args ?? [])];
    }
    case TACInstructionKind.PropertyGet:
      return [(inst as unknown as PropertyGetInstruction).object];
    case TACInstructionKind.PropertySet: {
      const set = inst as unknown as PropertySetInstruction;
      return [set.object, set.value];
    }
    case TACInstructionKind.Return: {
      const ret = inst as unknown as ReturnInstruction;
      return ret.value ? [ret.value] : [];
    }
    case TACInstructionKind.ArrayAccess: {
      const acc = inst as ArrayAccessInstruction;
      return [acc.array, acc.index];
    }
    case TACInstructionKind.ArrayAssignment: {
      const assign = inst as ArrayAssignmentInstruction;
      return [assign.array, assign.index, assign.value];
    }
    case TACInstructionKind.Phi: {
      const phi = inst as PhiInstruction;
      return phi.sources.map((source) => source.value);
    }
    default:
      return [];
  }
};

export const rewriteOperands = (
  inst: TACInstruction,
  rewrite: (operand: TACOperand) => TACOperand,
): void => {
  switch (inst.kind) {
    case TACInstructionKind.Assignment:
    case TACInstructionKind.Copy:
    case TACInstructionKind.Cast: {
      const typed = inst as unknown as InstWithDestSrc;
      typed.dest = rewrite(typed.dest);
      typed.src = rewrite(typed.src);
      return;
    }
    case TACInstructionKind.BinaryOp: {
      const bin = inst as BinaryOpInstruction;
      bin.dest = rewrite(bin.dest);
      bin.left = rewrite(bin.left);
      bin.right = rewrite(bin.right);
      return;
    }
    case TACInstructionKind.UnaryOp: {
      const unary = inst as UnaryOpInstruction;
      unary.dest = rewrite(unary.dest);
      unary.operand = rewrite(unary.operand);
      return;
    }
    case TACInstructionKind.ConditionalJump: {
      const cond = inst as unknown as ConditionalJumpInstruction;
      cond.condition = rewrite(cond.condition);
      return;
    }
    case TACInstructionKind.Call: {
      const call = inst as unknown as CallInstruction;
      if (call.dest) call.dest = rewrite(call.dest);
      call.args = call.args.map(rewrite);
      return;
    }
    case TACInstructionKind.MethodCall: {
      const method = inst as unknown as MethodCallInstruction;
      if (method.dest) method.dest = rewrite(method.dest);
      method.object = rewrite(method.object);
      method.args = method.args.map(rewrite);
      return;
    }
    case TACInstructionKind.PropertyGet: {
      const get = inst as unknown as PropertyGetInstruction;
      get.dest = rewrite(get.dest);
      get.object = rewrite(get.object);
      return;
    }
    case TACInstructionKind.PropertySet: {
      const set = inst as unknown as PropertySetInstruction;
      set.object = rewrite(set.object);
      set.value = rewrite(set.value);
      return;
    }
    case TACInstructionKind.Return: {
      const ret = inst as unknown as ReturnInstruction;
      if (ret.value) ret.value = rewrite(ret.value);
      return;
    }
    case TACInstructionKind.ArrayAccess: {
      const acc = inst as ArrayAccessInstruction;
      acc.dest = rewrite(acc.dest);
      acc.array = rewrite(acc.array);
      acc.index = rewrite(acc.index);
      return;
    }
    case TACInstructionKind.ArrayAssignment: {
      const assign = inst as ArrayAssignmentInstruction;
      assign.array = rewrite(assign.array);
      assign.index = rewrite(assign.index);
      assign.value = rewrite(assign.value);
      return;
    }
    case TACInstructionKind.Phi: {
      const phi = inst as PhiInstruction;
      phi.dest = rewrite(phi.dest);
      phi.sources = phi.sources.map((source) => ({
        pred: source.pred,
        value: rewrite(source.value),
      }));
      return;
    }
    default:
      return;
  }
};

export const getDefinedOperandForReuse = (
  inst: TACInstruction,
): TACOperand | undefined => {
  switch (inst.kind) {
    case TACInstructionKind.Assignment:
    case TACInstructionKind.Copy:
    case TACInstructionKind.BinaryOp:
    case TACInstructionKind.UnaryOp:
    case TACInstructionKind.Cast:
    case TACInstructionKind.PropertyGet:
    case TACInstructionKind.ArrayAccess:
      return (inst as unknown as InstWithDest).dest;
    case TACInstructionKind.Call:
    case TACInstructionKind.MethodCall:
      return (inst as { dest?: TACOperand }).dest;
    case TACInstructionKind.Phi:
      return (inst as unknown as InstWithDest).dest;
    default:
      return undefined;
  }
};

export const isPureProducer = (inst: TACInstruction): boolean => {
  return (
    inst.kind === TACInstructionKind.Assignment ||
    inst.kind === TACInstructionKind.Copy ||
    inst.kind === TACInstructionKind.BinaryOp ||
    inst.kind === TACInstructionKind.UnaryOp ||
    inst.kind === TACInstructionKind.Cast
  );
};

export const isCopyFromTemp = (inst: TACInstruction): boolean => {
  if (
    inst.kind !== TACInstructionKind.Assignment &&
    inst.kind !== TACInstructionKind.Copy
  ) {
    return false;
  }
  const { src } = inst as unknown as InstWithDestSrc;
  return src.kind === TACOperandKind.Temporary;
};

export const rewriteProducerDest = (
  inst: TACInstruction,
  newDest: TACOperand,
): TACInstruction => {
  switch (inst.kind) {
    case TACInstructionKind.Assignment:
    case TACInstructionKind.Copy: {
      const { src } = inst as unknown as InstWithDestSrc;
      return new AssignmentInstruction(newDest, src);
    }
    case TACInstructionKind.BinaryOp: {
      const bin = inst as BinaryOpInstruction;
      return new BinaryOpInstruction(
        newDest,
        bin.left,
        bin.operator,
        bin.right,
      );
    }
    case TACInstructionKind.UnaryOp: {
      const un = inst as UnaryOpInstruction;
      return new UnaryOpInstruction(newDest, un.operator, un.operand);
    }
    case TACInstructionKind.Cast: {
      const cast = inst as CastInstruction;
      return new CastInstruction(newDest, cast.src);
    }
    case TACInstructionKind.Call: {
      const call = inst as unknown as CallInstruction;
      return new CallInstruction(
        newDest,
        call.func,
        [...(call.args ?? [])],
        (call as CallInstruction).isTailCall ?? false,
      );
    }
    case TACInstructionKind.MethodCall: {
      const method = inst as unknown as MethodCallInstruction;
      return new MethodCallInstruction(
        newDest,
        method.object,
        method.method,
        [...(method.args ?? [])],
        (method as MethodCallInstruction).isTailCall ?? false,
      );
    }
    default:
      return inst;
  }
};

export const countTempUses = (
  instructions: TACInstruction[],
): Map<number, number> => {
  const counts = new Map<number, number>();
  const add = (operand: TACOperand) => {
    if (operand.kind !== TACOperandKind.Temporary) return;
    const id = (operand as TemporaryOperand).id;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  };

  for (const inst of instructions) {
    for (const op of getUsedOperandsForReuse(inst)) {
      add(op);
    }
  }

  return counts;
};

export const getMaxTempId = (instructions: TACInstruction[]): number => {
  let maxTempId = -1;
  for (const inst of instructions) {
    const def = getDefinedOperandForReuse(inst);
    if (def?.kind === TACOperandKind.Temporary) {
      maxTempId = Math.max(maxTempId, (def as TemporaryOperand).id);
    }
    for (const op of getUsedOperandsForReuse(inst)) {
      if (op.kind === TACOperandKind.Temporary) {
        maxTempId = Math.max(maxTempId, (op as TemporaryOperand).id);
      }
    }
  }
  return maxTempId;
};
