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
  aliasNames: Set<string>;
  contents: Map<number | string, DataTokenInfo | null>;
  phase: "init" | "post-init";
  valid: boolean;
  initInstructionIndices: Set<number>;
  initDataTokenCtorIndices: Set<number>;
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
    candidate.aliasNames.size > 0 &&
    operand.kind === TACOperandKind.Variable &&
    candidate.aliasNames.has((operand as VariableOperand).name)
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
      if (c.aliasNames.has(name)) return c;
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
  // Maps DataToken ctor temp IDs to their instruction index, for DCE of consumed ctors.
  const dataTokenCtorIndexByTemp = new Map<number, number>();

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
        dataTokenCtorIndexByTemp.clear();
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
        const dtTempId = (call.dest as TemporaryOperand).id;
        dataTokenDefs.set(dtTempId, {
          externSig: call.func,
          value: call.args[0] as ConstantOperand,
        });
        dataTokenCtorIndexByTemp.set(dtTempId, i);
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
          aliasNames: new Set(),
          contents: new Map(),
          phase: "init",
          valid: true,
          initInstructionIndices: new Set([i]),
          initDataTokenCtorIndices: new Set(),
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
          aliasNames: new Set(),
          contents: new Map(),
          phase: "init",
          valid: true,
          initInstructionIndices: new Set([i]),
          initDataTokenCtorIndices: new Set(),
          startIndex: i,
          nextIndex: 0,
        });
        continue;
      }

      if (candidates.size === 0) continue;

      // Any other Call: invalidate if dest overwrites a known alias variable,
      // or if a candidate appears as an arg (instructionUsesCandidate checks args only).
      if (call.dest && call.dest.kind === TACOperandKind.Variable) {
        const destName = (call.dest as VariableOperand).name;
        for (const c of [...candidates.values()]) {
          if (c.aliasNames.has(destName)) {
            invalidate(candidates, c);
            break;
          }
        }
      }
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

      // Front-load: invalidate any candidate appearing as an argument regardless of
      // whether the receiver is a candidate. A collection reference in any method
      // arg escapes into the callee, which could store or mutate it.
      for (const arg of mc.args) {
        for (const cArg of [...candidates.values()]) {
          if (matchesCandidate(arg, cArg)) {
            invalidate(candidates, cArg);
          }
        }
      }

      if (c?.valid) {
        if (c.phase === "init") {
          if (
            c.kind === "DataList" &&
            mc.method === "Add" &&
            mc.args.length === 1
          ) {
            const tokenArg = mc.args[0];
            const tokenTempId =
              tokenArg.kind === TACOperandKind.Temporary
                ? (tokenArg as TemporaryOperand).id
                : -1;
            const info =
              tokenTempId >= 0
                ? (dataTokenDefs.get(tokenTempId) ?? null)
                : null;
            c.contents.set(c.nextIndex, info);
            c.nextIndex++;
            c.initInstructionIndices.add(i);
            if (tokenTempId >= 0) {
              const ctorIdx = dataTokenCtorIndexByTemp.get(tokenTempId);
              if (ctorIdx !== undefined)
                c.initDataTokenCtorIndices.add(ctorIdx);
            }
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
            const valTempId =
              valArg.kind === TACOperandKind.Temporary
                ? (valArg as TemporaryOperand).id
                : -1;
            const valInfo =
              valTempId >= 0 ? (dataTokenDefs.get(valTempId) ?? null) : null;
            c.contents.set(keyString, valInfo);
            c.initInstructionIndices.add(i);
            const keyTempId =
              keyArg.kind === TACOperandKind.Temporary
                ? (keyArg as TemporaryOperand).id
                : -1;
            if (keyTempId >= 0) {
              const ctorIdx = dataTokenCtorIndexByTemp.get(keyTempId);
              if (ctorIdx !== undefined)
                c.initDataTokenCtorIndices.add(ctorIdx);
            }
            if (valTempId >= 0) {
              const ctorIdx = dataTokenCtorIndexByTemp.get(valTempId);
              if (ctorIdx !== undefined)
                c.initDataTokenCtorIndices.add(ctorIdx);
            }
            continue;
          }

          // First non-Add/SetValue method — init is over, transition to post-init
          c.phase = "post-init";
        }

        // post-init: safe reads don't invalidate
        // (c-in-args already handled by the front-loaded invalidation above)
        if (SAFE_POST_INIT_METHODS.has(mc.method)) {
          continue;
        }

        // Mutating method
        invalidate(candidates, c);
        continue;
      }

      // Receiver was null or was already invalidated by appearing in its own args.
      // Arg candidates already invalidated by the front-loaded loop above.
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
            // dest is being reassigned to this candidate; evict from any other
            // candidate regardless of phase to prevent stale alias ownership.
            for (const c of [...candidates.values()]) {
              if (c !== cBySrc && c.aliasNames.has(destVar.name)) {
                invalidate(candidates, c);
                break;
              }
            }
            cBySrc.aliasNames.add(destVar.name);
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
          // Temp-to-temp copy (e.g. ternary expression): dest is untracked,
          // so any mutation via it would be missed. Conservatively invalidate.
          invalidate(candidates, cBySrc);
        }
        continue;
      }

      if (cBySrc) {
        // src is a candidate temp in post-init (e.g. label-induced phase transition
        // then alias2 = t0). Register dest as alias so subsequent mutations via
        // alias2 are detected; evict from any other candidate that owned the name.
        if (assign.dest.kind === TACOperandKind.Variable) {
          const destVar = assign.dest as VariableOperand;
          if (destVar.isExported) {
            invalidate(candidates, cBySrc);
          } else {
            for (const c of [...candidates.values()]) {
              if (c !== cBySrc && c.aliasNames.has(destVar.name)) {
                invalidate(candidates, c);
                break;
              }
            }
            cBySrc.aliasNames.add(destVar.name);
            cBySrc.initInstructionIndices.add(i);
          }
        } else {
          // Temp-to-temp copy in post-init: dest is untracked, conservatively invalidate.
          invalidate(candidates, cBySrc);
        }
        continue;
      }

      // src is not a candidate temp from here on.

      // (A) Reassignment check — invalidate if dest was an alias of any candidate
      // and src is NOT the same collection. Phase guard removed: the alias-before-adds
      // pattern can leave candidates in "init" even after alias registration.
      if (assign.dest.kind === TACOperandKind.Variable) {
        const destName = (assign.dest as VariableOperand).name;
        for (const c of candidates.values()) {
          if (c.aliasNames.has(destName)) {
            const srcIsSameCollection =
              (assign.src.kind === TACOperandKind.Temporary &&
                (assign.src as TemporaryOperand).id === c.tempId) ||
              (assign.src.kind === TACOperandKind.Variable &&
                c.aliasNames.has((assign.src as VariableOperand).name));
            if (!srcIsSameCollection) invalidate(candidates, c);
            break;
          }
        }
      }

      // (B) Transitive alias: src is a known alias → add dest as alias too.
      // The alias-before-adds pattern (tempId as src, init phase) is handled by
      // the "cBySrc.phase === init" branch above. Variable-to-variable transitive
      // aliases may appear in both init and post-init. When seen in init after
      // adds have already occurred (nextIndex > 0 || contents.size > 0), the
      // init window is closed and we transition to post-init so that further
      // Add/SetValue via any alias is treated as a mutation.
      // Exported dest: dest is visible outside the method scope → invalidate.
      if (
        assign.src.kind === TACOperandKind.Variable &&
        assign.dest.kind === TACOperandKind.Variable
      ) {
        const srcName = (assign.src as VariableOperand).name;
        const destVar = assign.dest as VariableOperand;
        for (const c of candidates.values()) {
          if (c.aliasNames.has(srcName)) {
            if (destVar.isExported) {
              invalidate(candidates, c);
            } else {
              // Evict destVar from any other candidate before adding to this one.
              for (const cOther of [...candidates.values()]) {
                if (cOther !== c && cOther.aliasNames.has(destVar.name)) {
                  invalidate(candidates, cOther);
                  break;
                }
              }
              c.aliasNames.add(destVar.name);
              c.initInstructionIndices.add(i);
              if (
                c.phase === "init" &&
                (c.nextIndex > 0 || c.contents.size > 0)
              ) {
                c.phase = "post-init";
              }
            }
            break;
          }
        }
      }
      continue;
    }

    // PropertyGet: safe read for the object operand, but dest may overwrite a known alias.
    if (inst.kind === TACInstructionKind.PropertyGet) {
      const pg = inst as unknown as PropertyGetInstruction;
      if (pg.dest.kind === TACOperandKind.Variable) {
        const destName = (pg.dest as VariableOperand).name;
        for (const c of [...candidates.values()]) {
          if (c.aliasNames.has(destName)) {
            invalidate(candidates, c);
            break;
          }
        }
      }
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

    // PropertySet: invalidate if object or value matches (collection as value escapes)
    if (inst.kind === TACInstructionKind.PropertySet) {
      const ps = inst as unknown as { object: TACOperand; value: TACOperand };
      for (const c of [...candidates.values()]) {
        if (matchesCandidate(ps.object, c) || matchesCandidate(ps.value, c)) {
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
    for (const name of c.aliasNames) {
      let aliasArr = aliasToCandidates.get(name);
      if (!aliasArr) {
        aliasArr = [];
        aliasToCandidates.set(name, aliasArr);
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

  // When PropertyGet is immediately folded after a get_Item/GetValue replacement,
  // the DataToken ctor CallInstruction pushed to result becomes dead. Track these
  // so Pass 3 can remove them alongside the init instructions.
  const deadResultInstructions = new Set<TACInstruction>();

  // Fold a get_Item/GetValue replacement with optional immediate PropertyGet folding.
  // The DataToken ctor CallInstruction is always pushed to result to preserve the
  // result/instructions index correspondence. If PropertyGet is also folded, the
  // ctor is added to deadResultInstructions for removal in Pass 3.
  // Returns true if the following PropertyGet was consumed (caller should skip it).
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
          deadResultInstructions.add(newCall);
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

  // Also remove DataToken ctor instructions that were consumed exclusively by
  // init instructions now being DCE'd. Shared ctors (used elsewhere) are kept.
  const possibleCtorRemovals = new Set<number>();
  for (const c of allValidCandidates) {
    if ((residualUses.get(c.startIndex) ?? 0) === 0) {
      for (const idx of c.initDataTokenCtorIndices) {
        possibleCtorRemovals.add(idx);
      }
    }
  }
  for (const ctorIdx of possibleCtorRemovals) {
    const ctorInst = result[ctorIdx] as unknown as CallInstruction;
    if (!ctorInst.dest || ctorInst.dest.kind !== TACOperandKind.Temporary)
      continue;
    const ctorTempId = (ctorInst.dest as TemporaryOperand).id;
    let stillUsed = false;
    for (let i = 0; i < result.length; i++) {
      if (indicesToRemove.has(i) || possibleCtorRemovals.has(i)) continue;
      if (deadResultInstructions.has(result[i])) continue;
      forEachUsedOperand(result[i], (op) => {
        if (
          !stillUsed &&
          op.kind === TACOperandKind.Temporary &&
          (op as TemporaryOperand).id === ctorTempId
        ) {
          stillUsed = true;
        }
      });
      if (stillUsed) break;
    }
    if (!stillUsed) indicesToRemove.add(ctorIdx);
  }

  if (indicesToRemove.size === 0 && deadResultInstructions.size === 0) {
    return { instructions: result, changed };
  }

  const finalResult: TACInstruction[] = [];
  for (let i = 0; i < result.length; i++) {
    if (!indicesToRemove.has(i) && !deadResultInstructions.has(result[i])) {
      finalResult.push(result[i]);
    }
  }

  return {
    instructions: finalResult,
    changed: true,
    structurallyChanged: true,
  };
};
