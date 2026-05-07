import { PrimitiveTypes } from "../../../frontend/type_symbols.js";
import { UdonType } from "../../../frontend/types.js";
import {
  AssignmentInstruction,
  CallInstruction,
  type MethodCallInstruction,
  type PropertyGetInstruction,
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
import { getOperandType } from "./constant_folding.js";

const SAFE_POST_INIT_METHODS = new Set([
  "get_Item",
  "GetValue",
  "ContainsKey",
  "TryGetValue",
  "GetKeys",
  "GetValues",
  "ShallowClone",
  "IndexOf",
  "GetRange",
]);

// UdonType string → PropertyGet property name for non-null-check types only.
// Int/Long types are excluded because unwrapDataToken emits a 7-instruction
// null-check diamond for them; immediate folding would be unsound.
const UNWRAP_PROPERTY_MAP: Partial<Record<string, string>> = {
  [UdonType.String]: "String",
  [UdonType.Boolean]: "Boolean",
  [UdonType.Single]: "Float",
  [UdonType.Double]: "Double",
  [UdonType.DataList]: "DataList",
  [UdonType.DataDictionary]: "DataDictionary",
};

interface DataTokenInfo {
  externSig: string;
  value: ConstantOperand;
}

interface DataCollectionCandidate {
  kind: "DataList" | "DataDictionary";
  tempId: number;
  aliasName: string | null;
  contents: Map<number | string, DataTokenInfo | null>;
  phase: "init" | "post-init";
  valid: boolean;
  initInstructionIndices: Set<number>;
  startIndex: number;
  nextIndex: number;
}

function matchesCandidate(
  operand: TACOperand,
  candidate: DataCollectionCandidate,
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
  candidate: DataCollectionCandidate,
): boolean {
  let found = false;
  forEachUsedOperand(inst, (op) => {
    if (found) return;
    if (matchesCandidate(op, candidate)) found = true;
  });
  return found;
}

function findCandidateByTemp(
  candidates: Map<number, DataCollectionCandidate>,
  operand: TACOperand,
): DataCollectionCandidate | null {
  if (operand.kind !== TACOperandKind.Temporary) return null;
  return candidates.get((operand as TemporaryOperand).id) ?? null;
}

function findCandidateByTempOrAlias(
  candidates: Map<number, DataCollectionCandidate>,
  operand: TACOperand,
): DataCollectionCandidate | null {
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
  candidates: Map<number, DataCollectionCandidate>,
  candidate: DataCollectionCandidate,
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

function resolveStringKey(
  arg: TACOperand,
  dataTokenDefs: Map<number, DataTokenInfo>,
): string | null {
  if (arg.kind === TACOperandKind.Constant) {
    const c = arg as ConstantOperand;
    return typeof c.value === "string" ? c.value : null;
  }
  if (arg.kind === TACOperandKind.Temporary) {
    const info = dataTokenDefs.get((arg as TemporaryOperand).id);
    if (info && typeof info.value.value === "string") return info.value.value;
  }
  return null;
}

export const readonlyDataCollectionFolding = (
  instructions: TACInstruction[],
  exposedLabels?: Set<string>,
): PassResult => {
  const candidates = new Map<number, DataCollectionCandidate>();
  const allValidCandidates: DataCollectionCandidate[] = [];
  const exposedLabelIndices: number[] = [];
  const dataTokenDefs = new Map<number, DataTokenInfo>();

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
        dataTokenDefs.clear();
        continue;
      }
      for (const c of candidates.values()) {
        if (c.phase === "init") c.phase = "post-init";
      }
      continue;
    }

    if (inst.kind === TACInstructionKind.Call) {
      const call = inst as unknown as CallInstruction;

      // Track DataToken ctors for Add/SetValue argument resolution
      if (
        call.dest &&
        call.dest.kind === TACOperandKind.Temporary &&
        getOperandType(call.dest).udonType === UdonType.DataToken &&
        call.args.length === 1 &&
        call.args[0].kind === TACOperandKind.Constant
      ) {
        dataTokenDefs.set((call.dest as TemporaryOperand).id, {
          externSig: call.func,
          value: call.args[0] as ConstantOperand,
        });
      }

      // DataList ctor
      if (
        call.dest &&
        call.dest.kind === TACOperandKind.Temporary &&
        getOperandType(call.dest).udonType === UdonType.DataList &&
        call.args.length === 0
      ) {
        const tempId = (call.dest as TemporaryOperand).id;
        candidates.set(tempId, {
          kind: "DataList",
          tempId,
          aliasName: null,
          contents: new Map(),
          phase: "init",
          valid: true,
          initInstructionIndices: new Set([i]),
          startIndex: i,
          nextIndex: 0,
        });
        continue;
      }

      // DataDictionary ctor
      if (
        call.dest &&
        call.dest.kind === TACOperandKind.Temporary &&
        getOperandType(call.dest).udonType === UdonType.DataDictionary &&
        call.args.length === 0
      ) {
        const tempId = (call.dest as TemporaryOperand).id;
        candidates.set(tempId, {
          kind: "DataDictionary",
          tempId,
          aliasName: null,
          contents: new Map(),
          phase: "init",
          valid: true,
          initInstructionIndices: new Set([i]),
          startIndex: i,
          nextIndex: 0,
        });
        continue;
      }

      if (candidates.size === 0) continue;

      // Any other Call: invalidate if a candidate appears as an arg
      for (const c of [...candidates.values()]) {
        if (instructionUsesCandidate(inst, c)) {
          invalidate(candidates, c);
        }
      }
      continue;
    }

    if (candidates.size === 0) continue;

    // MethodCall
    if (inst.kind === TACInstructionKind.MethodCall) {
      const mc = inst as unknown as MethodCallInstruction;
      const c = findCandidateByTempOrAlias(candidates, mc.object);

      if (c) {
        if (c.phase === "init") {
          if (
            c.kind === "DataList" &&
            mc.method === "Add" &&
            mc.args.length === 1
          ) {
            const tokenArg = mc.args[0];
            const info =
              tokenArg.kind === TACOperandKind.Temporary
                ? (dataTokenDefs.get((tokenArg as TemporaryOperand).id) ?? null)
                : null;
            c.contents.set(c.nextIndex, info);
            c.nextIndex++;
            c.initInstructionIndices.add(i);
            continue;
          }

          if (
            c.kind === "DataDictionary" &&
            mc.method === "SetValue" &&
            mc.args.length === 2
          ) {
            const keyArg = mc.args[0];
            const valArg = mc.args[1];
            const keyString = resolveStringKey(keyArg, dataTokenDefs);
            if (keyString === null) {
              invalidate(candidates, c);
              continue;
            }
            const valInfo =
              valArg.kind === TACOperandKind.Temporary
                ? (dataTokenDefs.get((valArg as TemporaryOperand).id) ?? null)
                : null;
            c.contents.set(keyString, valInfo);
            c.initInstructionIndices.add(i);
            continue;
          }

          // First non-Add/SetValue method — init is over, transition to post-init
          c.phase = "post-init";
        }

        // post-init: safe reads don't invalidate
        if (SAFE_POST_INIT_METHODS.has(mc.method)) {
          // Check if the candidate also appears as an arg (unusual but conservative)
          for (const arg of mc.args) {
            if (matchesCandidate(arg, c)) {
              invalidate(candidates, c);
              break;
            }
          }
          continue;
        }

        // Mutating method
        invalidate(candidates, c);
        continue;
      }

      // Candidate is not the receiver; check if it is used as an arg
      for (const c2 of [...candidates.values()]) {
        if (instructionUsesCandidate(inst, c2)) {
          invalidate(candidates, c2);
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

      const cBySrc = findCandidateByTemp(candidates, assign.src);
      if (cBySrc && cBySrc.phase === "init") {
        if (assign.dest.kind === TACOperandKind.Variable) {
          const destVar = assign.dest as VariableOperand;
          if (destVar.isExported) {
            invalidate(candidates, cBySrc);
          } else {
            cBySrc.aliasName = destVar.name;
            cBySrc.initInstructionIndices.add(i);
            // If init operations have already started, the alias signals end of
            // init; subsequent mutations via alias must not be treated as init.
            // If no operations yet, stay in init so alias.Add/SetValue calls
            // below are tracked (real transpiler pattern: alias precedes adds).
            if (cBySrc.nextIndex > 0 || cBySrc.contents.size > 0) {
              cBySrc.phase = "post-init";
            }
          }
        } else {
          cBySrc.phase = "post-init";
        }
        continue;
      }

      if (assign.dest.kind === TACOperandKind.Variable) {
        const destName = (assign.dest as VariableOperand).name;
        for (const c of candidates.values()) {
          // Invalidate on alias reassignment regardless of phase.
          if (c.aliasName === destName) {
            invalidate(candidates, c);
            break;
          }
        }
      }
      continue;
    }

    // PropertyGet: safe read, no invalidation
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

    // Catch-all: invalidate any candidate whose operand is used
    for (const c of [...candidates.values()]) {
      if (instructionUsesCandidate(inst, c)) {
        invalidate(candidates, c);
      }
    }
  }

  // Collect remaining valid candidates
  for (const c of candidates.values()) {
    if (c.valid) allValidCandidates.push(c);
  }

  if (allValidCandidates.length === 0) {
    return { instructions, changed: false };
  }

  // Compute the valid fold range for each candidate
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
  const tempIdToCandidates = new Map<number, DataCollectionCandidate[]>();
  const aliasToCandidates = new Map<string, DataCollectionCandidate[]>();
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
    arr: DataCollectionCandidate[] | undefined,
    index: number,
  ): DataCollectionCandidate | null => {
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
  ): DataCollectionCandidate | null => {
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

  // Fold a get_Item/GetValue replacement with optional immediate PropertyGet folding.
  // Returns the number of additional instructions consumed (0 or 1).
  const foldWithPropertyGet = (
    result: TACInstruction[],
    entry: DataTokenInfo,
    dest: TACOperand,
    i: number,
  ): boolean => {
    const newCall = new CallInstruction(dest, entry.externSig, [entry.value]);
    const expectedProp = UNWRAP_PROPERTY_MAP[entry.value.type.udonType];
    if (expectedProp !== undefined && i + 1 < instructions.length) {
      const nextInst = instructions[i + 1];
      if (nextInst.kind === TACInstructionKind.PropertyGet) {
        const pg = nextInst as unknown as PropertyGetInstruction;
        if (
          dest.kind === TACOperandKind.Temporary &&
          pg.object.kind === TACOperandKind.Temporary &&
          (pg.object as TemporaryOperand).id ===
            (dest as TemporaryOperand).id &&
          pg.property === expectedProp
        ) {
          result.push(newCall);
          result.push(new AssignmentInstruction(pg.dest, entry.value));
          return true;
        }
      }
    }
    result.push(newCall);
    return false;
  };

  // Pass 2: rewrite
  let changed = false;
  const result: TACInstruction[] = [];
  const dataTokenDefs2 = new Map<number, DataTokenInfo>();

  for (let i = 0; i < instructions.length; i++) {
    const inst = instructions[i];

    if (inst.kind === TACInstructionKind.Label) {
      const name = getLabelName(inst);
      if (exposedLabels?.has(name)) dataTokenDefs2.clear();
      result.push(inst);
      continue;
    }

    // Rebuild DataToken defs for key resolution
    if (inst.kind === TACInstructionKind.Call) {
      const call = inst as unknown as CallInstruction;
      if (
        call.dest &&
        call.dest.kind === TACOperandKind.Temporary &&
        getOperandType(call.dest).udonType === UdonType.DataToken &&
        call.args.length === 1 &&
        call.args[0].kind === TACOperandKind.Constant
      ) {
        dataTokenDefs2.set((call.dest as TemporaryOperand).id, {
          externSig: call.func,
          value: call.args[0] as ConstantOperand,
        });
      }
      result.push(inst);
      continue;
    }

    if (inst.kind === TACInstructionKind.MethodCall) {
      const mc = inst as unknown as MethodCallInstruction;

      if (mc.dest) {
        const c = findValidCandidateAt(mc.object, i);

        if (c) {
          if (c.kind === "DataList" && mc.method === "get_Item") {
            const idx =
              mc.args.length === 1 ? getConstantInt(mc.args[0]) : null;
            if (idx !== null) {
              const entry = c.contents.get(idx);
              if (entry !== undefined && entry !== null) {
                const skipped = foldWithPropertyGet(result, entry, mc.dest, i);
                if (skipped) i++;
                changed = true;
                continue;
              }
            }
          }

          if (c.kind === "DataDictionary") {
            // get_Item: bracket access lookup["key"] (string constant arg)
            // GetValue: DataToken-wrapped key via SetValue/GetValue API
            if (
              (mc.method === "get_Item" || mc.method === "GetValue") &&
              mc.args.length === 1
            ) {
              const keyStr = resolveStringKey(mc.args[0], dataTokenDefs2);
              if (keyStr !== null) {
                const entry = c.contents.get(keyStr);
                if (entry !== undefined && entry !== null) {
                  const skipped = foldWithPropertyGet(
                    result,
                    entry,
                    mc.dest,
                    i,
                  );
                  if (skipped) i++;
                  changed = true;
                  continue;
                }
              }
            }

            if (mc.method === "ContainsKey" && mc.args.length === 1) {
              const keyStr = resolveStringKey(mc.args[0], dataTokenDefs2);
              if (keyStr !== null) {
                result.push(
                  new AssignmentInstruction(
                    mc.dest,
                    createConstant(
                      c.contents.has(keyStr),
                      PrimitiveTypes.boolean,
                    ),
                  ),
                );
                changed = true;
                continue;
              }
            }
          }
        }
      }

      result.push(inst);
      continue;
    }

    result.push(inst);
  }

  if (!changed) {
    return { instructions, changed: false };
  }

  // Pass 3: remove init instructions for candidates with zero residual uses
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
