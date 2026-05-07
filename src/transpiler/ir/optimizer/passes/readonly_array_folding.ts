import {
  NativeArrayTypeSymbol,
  type TypeSymbol,
} from "../../../frontend/type_symbols.js";
import { UdonType } from "../../../frontend/types.js";
import {
  type ArrayAccessInstruction,
  type ArrayAssignmentInstruction,
  AssignmentInstruction,
  type CallInstruction,
  type TACInstruction,
  TACInstructionKind,
} from "../../tac_instruction.js";
import {
  type ConstantOperand,
  createConstant,
  type LabelOperand,
  type TACOperand,
  TACOperandKind,
  type TemporaryOperand,
  type VariableOperand,
} from "../../tac_operand.js";
import type { PassResult } from "../pass_types.js";
import { forEachUsedOperand } from "../utils/instructions.js";
import { getOperandType, isNumericUdonType } from "./constant_folding.js";

interface ArrayCandidate {
  tempId: number;
  aliasName: string | null;
  contents: Map<number, ConstantOperand | null>;
  phase: "init" | "post-init";
  valid: boolean;
  initInstructionIndices: Set<number>;
  startIndex: number;
  arrayLength: number;
  elementType: TypeSymbol;
}

function matchesCandidate(
  operand: TACOperand,
  candidate: ArrayCandidate,
): boolean {
  if (
    operand.kind === TACOperandKind.Temporary &&
    (operand as TemporaryOperand).id === candidate.tempId
  ) {
    return true;
  }
  if (
    candidate.aliasName !== null &&
    operand.kind === TACOperandKind.Variable &&
    (operand as VariableOperand).name === candidate.aliasName
  ) {
    return true;
  }
  return false;
}

function instructionUsesCandidate(
  inst: TACInstruction,
  candidate: ArrayCandidate,
): boolean {
  let found = false;
  forEachUsedOperand(inst, (op) => {
    if (found) return;
    if (matchesCandidate(op, candidate)) found = true;
  });
  return found;
}

function findCandidateByTemp(
  candidates: Map<number, ArrayCandidate>,
  operand: TACOperand,
): ArrayCandidate | null {
  if (operand.kind !== TACOperandKind.Temporary) return null;
  return candidates.get((operand as TemporaryOperand).id) ?? null;
}

function findCandidateByTempOrAlias(
  candidates: Map<number, ArrayCandidate>,
  operand: TACOperand,
): ArrayCandidate | null {
  if (operand.kind === TACOperandKind.Temporary) {
    return candidates.get((operand as TemporaryOperand).id) ?? null;
  }
  if (operand.kind === TACOperandKind.Variable) {
    const name = (operand as VariableOperand).name;
    for (const c of candidates.values()) {
      if (c.aliasName === name) return c;
    }
  }
  return null;
}

function invalidate(
  candidates: Map<number, ArrayCandidate>,
  candidate: ArrayCandidate,
): void {
  candidate.valid = false;
  candidates.delete(candidate.tempId);
}

function getConstantInt(operand: TACOperand): number | null {
  if (operand.kind !== TACOperandKind.Constant) return null;
  const c = operand as ConstantOperand;
  if (typeof c.value !== "number") return null;
  if (!Number.isInteger(c.value)) return null;
  return c.value;
}

function getLabelName(inst: TACInstruction): string {
  return ((inst as unknown as { label: LabelOperand }).label as LabelOperand)
    .name;
}

function getTypeDefault(elementType: TypeSymbol): ConstantOperand | null {
  const t = elementType.udonType;
  if (t === UdonType.Boolean) return createConstant(false, elementType);
  if (t === UdonType.Int64 || t === UdonType.UInt64)
    return createConstant(0n, elementType);
  if (isNumericUdonType(t)) return createConstant(0, elementType);
  // Char and Decimal are intentionally omitted: NATIVE_ARRAY_TYPE_NAMES, type_mapper.ts,
  // and the assembler type classification do not support them yet, so folding to a
  // constant would produce unverified UASM output. Return null (skip fold) until
  // the full codegen path is wired up for those types.
  if (t === UdonType.String) return createConstant(null, elementType);
  return null;
}

export const readonlyArrayFolding = (
  instructions: TACInstruction[],
  exposedLabels?: Set<string>,
): PassResult => {
  const candidates = new Map<number, ArrayCandidate>();
  const allValidCandidates: ArrayCandidate[] = [];
  const exposedLabelIndices: number[] = [];

  // Pass 1: collect candidates and validate
  for (let i = 0; i < instructions.length; i++) {
    const inst = instructions[i];

    if (inst.kind === TACInstructionKind.Label) {
      const name = getLabelName(inst);
      if (exposedLabels?.has(name)) {
        exposedLabelIndices.push(i);
        for (const c of candidates.values()) {
          if (c.valid) allValidCandidates.push(c);
        }
        candidates.clear();
        continue;
      }
      for (const c of candidates.values()) {
        if (c.phase === "init") c.phase = "post-init";
      }
      continue;
    }

    // Candidate detection: CallInstruction producing NativeArray
    if (inst.kind === TACInstructionKind.Call) {
      const call = inst as unknown as CallInstruction;
      if (
        call.dest &&
        call.dest.kind === TACOperandKind.Temporary &&
        call.args.length >= 1
      ) {
        const arrayType = getOperandType(call.dest);
        if (arrayType instanceof NativeArrayTypeSymbol) {
          const length = getConstantInt(call.args[0]);
          if (length !== null && length >= 0) {
            const tempId = (call.dest as TemporaryOperand).id;
            candidates.set(tempId, {
              tempId,
              aliasName: null,
              contents: new Map(),
              phase: "init",
              valid: true,
              initInstructionIndices: new Set([i]),
              startIndex: i,
              arrayLength: length,
              elementType: arrayType.elementType,
            });
            continue;
          }
        }
      }
    }

    if (candidates.size === 0) continue;

    // ArrayAssignment
    if (inst.kind === TACInstructionKind.ArrayAssignment) {
      const assign = inst as unknown as ArrayAssignmentInstruction;
      const c = findCandidateByTempOrAlias(candidates, assign.array);
      if (c) {
        if (c.phase === "init") {
          const idx = getConstantInt(assign.index);
          if (idx === null) {
            invalidate(candidates, c);
          } else {
            const valConst =
              assign.value.kind === TACOperandKind.Constant
                ? (assign.value as ConstantOperand)
                : null;
            c.contents.set(idx, valConst);
            c.initInstructionIndices.add(i);
          }
        } else {
          invalidate(candidates, c);
        }
      }
      continue;
    }

    // Assignment / Copy: alias tracking or reassignment invalidation
    if (
      inst.kind === TACInstructionKind.Assignment ||
      inst.kind === TACInstructionKind.Copy
    ) {
      const assign = inst as unknown as { dest: TACOperand; src: TACOperand };

      // Check if src matches a candidate temp (alias creation)
      const cBySrc = findCandidateByTemp(candidates, assign.src);
      if (cBySrc && cBySrc.phase === "init") {
        if (assign.dest.kind === TACOperandKind.Variable) {
          const destVar = assign.dest as VariableOperand;
          if (destVar.isExported) {
            invalidate(candidates, cBySrc);
          } else {
            cBySrc.aliasName = destVar.name;
            cBySrc.initInstructionIndices.add(i);
            cBySrc.phase = "post-init";
          }
        } else {
          cBySrc.phase = "post-init";
        }
        continue;
      }

      // Check if dest is an alias being reassigned (post-init invalidation)
      if (assign.dest.kind === TACOperandKind.Variable) {
        const destName = (assign.dest as VariableOperand).name;
        for (const c of candidates.values()) {
          if (c.aliasName === destName && c.phase === "post-init") {
            invalidate(candidates, c);
            break;
          }
        }
      }
      continue;
    }

    // ArrayAccess: safe read, no invalidation
    if (inst.kind === TACInstructionKind.ArrayAccess) {
      continue;
    }

    // PropertyGet: safe read
    if (inst.kind === TACInstructionKind.PropertyGet) {
      continue;
    }

    // Jump/Return: transition init -> post-init, then invalidate if operand used
    if (
      inst.kind === TACInstructionKind.UnconditionalJump ||
      inst.kind === TACInstructionKind.ConditionalJump ||
      inst.kind === TACInstructionKind.Return
    ) {
      for (const c of candidates.values()) {
        if (c.phase === "init") c.phase = "post-init";
      }

      for (const c of [...candidates.values()]) {
        if (instructionUsesCandidate(inst, c)) {
          invalidate(candidates, c);
        }
      }
      continue;
    }

    // PropertySet: invalidate if object matches
    if (inst.kind === TACInstructionKind.PropertySet) {
      const ps = inst as unknown as { object: TACOperand };
      for (const c of [...candidates.values()]) {
        if (matchesCandidate(ps.object, c)) {
          invalidate(candidates, c);
        }
      }
      continue;
    }

    // MethodCall / Call: invalidate if any operand matches
    if (
      inst.kind === TACInstructionKind.MethodCall ||
      inst.kind === TACInstructionKind.Call
    ) {
      for (const c of [...candidates.values()]) {
        if (instructionUsesCandidate(inst, c)) {
          invalidate(candidates, c);
        }
      }
      continue;
    }

    // Catch-all: invalidate any candidate whose operand is used
    for (const c of [...candidates.values()]) {
      if (instructionUsesCandidate(inst, c)) {
        invalidate(candidates, c);
      }
    }
  }

  // Collect all remaining valid candidates from the map
  for (const c of candidates.values()) {
    if (c.valid) allValidCandidates.push(c);
  }

  if (allValidCandidates.length === 0) {
    return { instructions, changed: false };
  }

  // Compute the valid fold range for each candidate:
  // from startIndex to the next exposedLabel (or end of stream)
  // Keyed by startIndex (unique per candidate) instead of tempId (may collide)
  const candidateEndIndex = new Map<number, number>();
  for (const c of allValidCandidates) {
    let end = instructions.length;
    for (const labelIdx of exposedLabelIndices) {
      if (labelIdx > c.startIndex) {
        end = labelIdx;
        break;
      }
    }
    candidateEndIndex.set(c.startIndex, end);
  }

  // Build lookup structures for Pass 2
  // Both maps use arrays to handle tempId/alias collisions across method segments
  const tempIdToCandidates = new Map<number, ArrayCandidate[]>();
  const aliasToCandidates = new Map<string, ArrayCandidate[]>();
  for (const c of allValidCandidates) {
    let tempArr = tempIdToCandidates.get(c.tempId);
    if (!tempArr) {
      tempArr = [];
      tempIdToCandidates.set(c.tempId, tempArr);
    }
    tempArr.push(c);
    if (c.aliasName !== null) {
      let aliasArr = aliasToCandidates.get(c.aliasName);
      if (!aliasArr) {
        aliasArr = [];
        aliasToCandidates.set(c.aliasName, aliasArr);
      }
      aliasArr.push(c);
    }
  }

  const findCandidateInRange = (
    arr: ArrayCandidate[] | undefined,
    index: number,
  ): ArrayCandidate | null => {
    if (!arr) return null;
    for (const c of arr) {
      const end = candidateEndIndex.get(c.startIndex) ?? instructions.length;
      if (index >= c.startIndex && index < end) return c;
    }
    return null;
  };

  const findValidCandidateAt = (
    operand: TACOperand,
    index: number,
  ): ArrayCandidate | null => {
    if (operand.kind === TACOperandKind.Temporary) {
      return findCandidateInRange(
        tempIdToCandidates.get((operand as TemporaryOperand).id),
        index,
      );
    }
    if (operand.kind === TACOperandKind.Variable) {
      return findCandidateInRange(
        aliasToCandidates.get((operand as VariableOperand).name),
        index,
      );
    }
    return null;
  };

  // Pass 2: rewrite
  let changed = false;
  const result: TACInstruction[] = [];

  for (let i = 0; i < instructions.length; i++) {
    const inst = instructions[i];
    if (inst.kind === TACInstructionKind.ArrayAccess) {
      const acc = inst as ArrayAccessInstruction;
      const c = findValidCandidateAt(acc.array, i);
      if (c) {
        const idx = getConstantInt(acc.index);
        if (idx !== null) {
          const constVal = c.contents.get(idx);
          if (constVal !== undefined) {
            if (constVal !== null) {
              result.push(new AssignmentInstruction(acc.dest, constVal));
              changed = true;
              continue;
            }
          } else if (idx >= 0 && idx < c.arrayLength) {
            const defaultVal = getTypeDefault(c.elementType);
            if (defaultVal !== null) {
              result.push(new AssignmentInstruction(acc.dest, defaultVal));
              changed = true;
              continue;
            }
          }
        }
      }
    }
    result.push(inst);
  }

  if (!changed) {
    return { instructions, changed: false };
  }

  // Check residual uses for each candidate (keyed by startIndex to avoid
  // tempId collisions across method segments)
  const residualUses = new Map<number, number>();
  for (const c of allValidCandidates) {
    residualUses.set(c.startIndex, 0);
  }

  for (let i = 0; i < result.length; i++) {
    const inst = result[i];
    for (const c of allValidCandidates) {
      if (c.initInstructionIndices.has(i)) continue;
      const end = candidateEndIndex.get(c.startIndex) ?? instructions.length;
      if (i < c.startIndex || i >= end) continue;
      if (instructionUsesCandidate(inst, c)) {
        residualUses.set(
          c.startIndex,
          (residualUses.get(c.startIndex) ?? 0) + 1,
        );
      }
    }
  }

  // Remove init instructions for candidates with zero residual uses
  const indicesToRemove = new Set<number>();
  for (const c of allValidCandidates) {
    if ((residualUses.get(c.startIndex) ?? 0) === 0) {
      for (const idx of c.initInstructionIndices) {
        indicesToRemove.add(idx);
      }
    }
  }

  if (indicesToRemove.size === 0) {
    return { instructions: result, changed };
  }

  const finalResult: TACInstruction[] = [];
  for (let i = 0; i < result.length; i++) {
    if (!indicesToRemove.has(i)) {
      finalResult.push(result[i]);
    }
  }

  return {
    instructions: finalResult,
    changed: true,
    structurallyChanged: true,
  };
};
