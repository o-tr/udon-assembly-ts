import {
  type ArrayAccessInstruction,
  type ArrayAssignmentInstruction,
  AssignmentInstruction,
  type BinaryOpInstruction,
  type CallInstruction,
  type CastInstruction,
  type ConditionalJumpInstruction,
  CopyInstruction,
  type LabelInstruction,
  type MethodCallInstruction,
  type PropertyGetInstruction,
  type PropertySetInstruction,
  type ReturnInstruction,
  type TACInstruction,
  TACInstructionKind,
  type UnaryOpInstruction,
  UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import type {
  ConstantOperand,
  ConstantValue,
  LabelOperand,
  TACOperand,
  TemporaryOperand,
  VariableOperand,
} from "../../tac_operand.js";
import {
  createTemporary,
  createVariable,
  parseTemporaryLatticeKey,
  TACOperandKind,
  temporaryLatticeKey,
} from "../../tac_operand.js";
import { buildCFG } from "../analysis/cfg.js";
import type { CFGPassOptions, PassResult } from "../pass_types.js";
import {
  forEachUsedOperand,
  getDefinedOperandForReuse,
  type InstWithDestSrc,
} from "../utils/instructions.js";
import { isTruthyConstant } from "./boolean_simplification.js";
import { getOperandType } from "./constant_folding.js";
import { resolveReachableSuccs } from "./jumps.js";
import { isCopyOnWriteCandidateType } from "./temp_reuse.js";

// Threshold for compacting the array-backed worklist queue. Keeps memory
// bounded for oscillating/non-converging graphs.
const WORKLIST_COMPACT_THRESHOLD = 1024;

export type LatticeValue =
  | { kind: "unknown" }
  | { kind: "overdefined" }
  | { kind: "constant"; operand: ConstantOperand }
  | { kind: "copy"; operand: VariableOperand };

// Lattice kind encoding for Uint8Array
const KIND_UNKNOWN = 0;
const KIND_OVERDEFINED = 1;
const KIND_CONSTANT = 2;
const KIND_COPY = 3;

/**
 * Maps variable name strings to dense numeric IDs.
 * Built once before the fixed-point loop; fixed after construction.
 */
class VariableIdMap {
  private readonly nameToId = new Map<string, number>();
  private _size = 0;

  register(name: string): void {
    if (!this.nameToId.has(name)) {
      this.nameToId.set(name, this._size++);
    }
  }

  getId(name: string): number {
    const id = this.nameToId.get(name);
    if (id === undefined) {
      throw new Error(`Variable not registered: ${name}`);
    }
    return id;
  }

  tryGetId(name: string): number {
    return this.nameToId.get(name) ?? -1;
  }

  /** Iterate all registered lattice slot names (for alias invalidation scans). */
  forEachName(fn: (name: string) => void): void {
    for (const name of this.nameToId.keys()) {
      fn(name);
    }
  }

  get size(): number {
    return this._size;
  }
}

/**
 * Compact lattice representation using Uint8Array for kinds
 * and a sparse Map for constant/copy payloads.
 */
class CompactLattice {
  kinds: Uint8Array;
  readonly payloads: Map<number, ConstantOperand | VariableOperand>;
  private readonly varIds: VariableIdMap;
  readonly dirty: Set<number> = new Set();

  constructor(numVars: number, varIds: VariableIdMap) {
    this.kinds = new Uint8Array(numVars);
    this.payloads = new Map();
    this.varIds = varIds;
  }

  resetFrom(
    sourceKinds: Uint8Array,
    sourcePayloads: Map<number, ConstantOperand | VariableOperand>,
  ): void {
    this.kinds.set(sourceKinds);
    this.payloads.clear();
    for (const [k, v] of sourcePayloads) {
      this.payloads.set(k, v);
    }
    this.dirty.clear();
  }

  clearDirty(): void {
    this.dirty.clear();
  }

  get(name: string): LatticeValue {
    const id = this.varIds.tryGetId(name);
    if (id === -1) return { kind: "unknown" };
    return this.getById(id);
  }

  getById(id: number): LatticeValue {
    const kind = this.kinds[id];
    if (kind === KIND_UNKNOWN) return { kind: "unknown" };
    if (kind === KIND_OVERDEFINED) return { kind: "overdefined" };
    const payload = this.payloads.get(id);
    if (!payload) return { kind: "overdefined" }; // defensive
    if (kind === KIND_CONSTANT) {
      return { kind: "constant", operand: payload as ConstantOperand };
    }
    // KIND_COPY
    return { kind: "copy", operand: payload as VariableOperand };
  }

  setOverdefined(name: string): void {
    const id = this.varIds.tryGetId(name);
    if (id === -1) return;
    this.setOverdefinedById(id);
  }

  setOverdefinedById(id: number): void {
    if (this.kinds[id] === KIND_CONSTANT || this.kinds[id] === KIND_COPY) {
      this.payloads.delete(id);
    }
    this.kinds[id] = KIND_OVERDEFINED;
    this.dirty.add(id);
  }

  setConstant(name: string, op: ConstantOperand): void {
    const id = this.varIds.tryGetId(name);
    if (id === -1) return;
    this.kinds[id] = KIND_CONSTANT;
    this.payloads.set(id, op);
    this.dirty.add(id);
  }

  setCopy(name: string, op: VariableOperand): void {
    const id = this.varIds.tryGetId(name);
    if (id === -1) return;
    this.kinds[id] = KIND_COPY;
    this.payloads.set(id, op);
    this.dirty.add(id);
  }

  get payloadCount(): number {
    return this.payloads.size;
  }

  clone(): CompactLattice {
    const result = new CompactLattice(this.kinds.length, this.varIds);
    result.kinds.set(this.kinds);
    for (const [k, v] of this.payloads) {
      result.payloads.set(k, v);
    }
    return result;
  }

  equals(other: CompactLattice): boolean {
    // Cheapest check: payload count mismatch
    if (this.payloads.size !== other.payloads.size) return false;

    // Byte-by-byte kinds comparison
    const a = this.kinds;
    const b = other.kinds;
    const len = a.length;
    for (let i = 0; i < len; i++) {
      if (a[i] !== b[i]) return false;
    }

    // Payload content comparison
    for (const [id, payload] of this.payloads) {
      const otherPayload = other.payloads.get(id);
      if (!otherPayload) return false;
      if (this.kinds[id] === KIND_CONSTANT) {
        const a = payload as ConstantOperand;
        const b = otherPayload as ConstantOperand;
        if (
          a.type.udonType !== b.type.udonType ||
          !constantValueEquals(a.value, b.value)
        ) {
          return false;
        }
      } else {
        // KIND_COPY
        if (
          (payload as VariableOperand).name !==
          (otherPayload as VariableOperand).name
        ) {
          return false;
        }
      }
    }

    return true;
  }

  /** @internal Retained for potential per-block lattice merge strategies. */
  static mergeFrom(
    preds: CompactLattice[],
    numVars: number,
    varIds: VariableIdMap,
  ): CompactLattice {
    if (preds.length === 0) return new CompactLattice(numVars, varIds);
    if (preds.length === 1) return preds[0].clone();

    const result = new CompactLattice(numVars, varIds);
    const resultKinds = result.kinds;
    const resultPayloads = result.payloads;

    for (let id = 0; id < numVars; id++) {
      let accKind = KIND_UNKNOWN;
      let accPayload: ConstantOperand | VariableOperand | undefined;

      for (let p = 0; p < preds.length; p++) {
        const predKind = preds[p].kinds[id];

        if (predKind === KIND_UNKNOWN) continue;

        if (predKind === KIND_OVERDEFINED) {
          accKind = KIND_OVERDEFINED;
          accPayload = undefined;
          break;
        }

        // predKind is constant or copy
        const predPayload = preds[p].payloads.get(id);
        if (!predPayload) {
          // defensive: missing payload treated as overdefined
          accKind = KIND_OVERDEFINED;
          accPayload = undefined;
          break;
        }

        if (accKind === KIND_UNKNOWN) {
          // First non-unknown value
          accKind = predKind;
          accPayload = predPayload;
          continue;
        }

        // Both acc and pred are constant or copy
        if (accKind !== predKind) {
          // Mixed constant/copy
          accKind = KIND_OVERDEFINED;
          accPayload = undefined;
          break;
        }

        // Same kind — check value equality
        if (accKind === KIND_CONSTANT) {
          const a = accPayload as ConstantOperand;
          const b = predPayload as ConstantOperand;
          if (
            a.type.udonType !== b.type.udonType ||
            !constantValueEquals(a.value, b.value)
          ) {
            accKind = KIND_OVERDEFINED;
            accPayload = undefined;
            break;
          }
        } else {
          // KIND_COPY
          if (
            (accPayload as VariableOperand).name !==
            (predPayload as VariableOperand).name
          ) {
            accKind = KIND_OVERDEFINED;
            accPayload = undefined;
            break;
          }
        }
      }

      if (accKind !== KIND_UNKNOWN) {
        resultKinds[id] = accKind;
        if (accPayload) {
          resultPayloads.set(id, accPayload);
        }
      }
    }

    return result;
  }
}

// Compares ConstantValue instances for structural equality.
// Handles: number, string, boolean, bigint, null, number[], Record<string, number>.
const constantValueEquals = (a: ConstantValue, b: ConstantValue): boolean => {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (a === null || b === null) return false;
  const isArrayA = Array.isArray(a);
  const isArrayB = Array.isArray(b);
  if (isArrayA !== isArrayB) return false;
  if (isArrayA) {
    const arrA = a as number[];
    const arrB = b as number[];
    if (arrA.length !== arrB.length) return false;
    for (let i = 0; i < arrA.length; i++) {
      if (arrA[i] !== arrB[i]) return false;
    }
    return true;
  }
  const recA = a as Record<string, number>;
  const recB = b as Record<string, number>;
  const keysA = Object.keys(recA);
  const keysB = Object.keys(recB);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (recA[key] !== recB[key]) return false;
  }
  return true;
};

/**
 * Meet a local lattice value for a variable into the global lattice.
 * Returns true if the global lattice changed.
 */
const meetIntoGlobal = (
  varId: number,
  localKind: number,
  localPayload: ConstantOperand | VariableOperand | undefined,
  globalKinds: Uint8Array,
  globalPayloads: Map<number, ConstantOperand | VariableOperand>,
): boolean => {
  const gKind = globalKinds[varId];

  // Already at top — no change possible
  if (gKind === KIND_OVERDEFINED) return false;

  // Local is unknown — no new information
  if (localKind === KIND_UNKNOWN) return false;

  // Local is overdefined → global becomes overdefined
  if (localKind === KIND_OVERDEFINED) {
    globalKinds[varId] = KIND_OVERDEFINED;
    globalPayloads.delete(varId);
    return true;
  }

  // Global is unknown — first information about this variable
  if (gKind === KIND_UNKNOWN) {
    globalKinds[varId] = localKind;
    if (localPayload) {
      globalPayloads.set(varId, localPayload);
    }
    return true;
  }

  // Both global and local are constant or copy
  if (gKind !== localKind) {
    // Mixed constant/copy → overdefined
    globalKinds[varId] = KIND_OVERDEFINED;
    globalPayloads.delete(varId);
    return true;
  }

  // Same kind — check value equality
  const gPayload = globalPayloads.get(varId);
  if (!gPayload || !localPayload) {
    // Defensive: missing payload → overdefined
    globalKinds[varId] = KIND_OVERDEFINED;
    globalPayloads.delete(varId);
    return true;
  }

  if (gKind === KIND_CONSTANT) {
    const a = gPayload as ConstantOperand;
    const b = localPayload as ConstantOperand;
    if (
      a.type.udonType !== b.type.udonType ||
      !constantValueEquals(a.value, b.value)
    ) {
      globalKinds[varId] = KIND_OVERDEFINED;
      globalPayloads.delete(varId);
      return true;
    }
    // Same constant — no change
    return false;
  }

  // KIND_COPY
  if (
    (gPayload as VariableOperand).name !==
    (localPayload as VariableOperand).name
  ) {
    globalKinds[varId] = KIND_OVERDEFINED;
    globalPayloads.delete(varId);
    return true;
  }
  // Same copy target — no change
  return false;
};

/** Lattice slot name for Variable or Temporary; null for other operand kinds. */
const latticeNameForOperand = (op: TACOperand): string | null => {
  if (op.kind === TACOperandKind.Variable) {
    return (op as VariableOperand).name;
  }
  if (op.kind === TACOperandKind.Temporary) {
    return temporaryLatticeKey((op as TemporaryOperand).id);
  }
  return null;
};

const resolveLatticeConstantCompact = (
  operand: TACOperand,
  lattice: CompactLattice,
  varIds: VariableIdMap,
): ConstantOperand | null => {
  if (operand.kind === TACOperandKind.Constant) {
    return operand as ConstantOperand;
  }
  const startName = latticeNameForOperand(operand);
  if (startName === null) return null;

  let steps = lattice.payloadCount + 1;
  let currentName = startName;
  while (steps-- > 0) {
    const id = varIds.tryGetId(currentName);
    if (id === -1) return null;
    const kind = lattice.kinds[id];
    if (kind === KIND_UNKNOWN || kind === KIND_OVERDEFINED) return null;
    if (kind === KIND_CONSTANT) {
      const payload = lattice.payloads.get(id);
      return payload ? (payload as ConstantOperand) : null;
    }
    // KIND_COPY
    const payload = lattice.payloads.get(id);
    if (!payload) return null;
    currentName = (payload as VariableOperand).name;
  }
  return null;
};

/**
 * Map a lattice VariableOperand (possibly synthetic temp lattice name) back to
 * VariableOperand or TemporaryOperand for emitted IR.
 */
const latticeVariableToTacOperand = (v: VariableOperand): TACOperand => {
  const tid = parseTemporaryLatticeKey(v.name);
  if (tid !== null) {
    return createTemporary(tid, v.type);
  }
  return v;
};

/**
 * When lattice gives no constant: preserve operand identity only while `current`
 * still denotes the same lattice slot as `original` (after copy-chain walks).
 */
const resolveNonConstantOperand = (
  original: TACOperand,
  current: VariableOperand,
): TACOperand => {
  if (original.kind === TACOperandKind.Temporary) {
    const key = temporaryLatticeKey((original as TemporaryOperand).id);
    return current.name === key
      ? original
      : latticeVariableToTacOperand(current);
  }
  if (original.kind === TACOperandKind.Variable) {
    return (original as VariableOperand).name === current.name
      ? original
      : latticeVariableToTacOperand(current);
  }
  return latticeVariableToTacOperand(current);
};

/**
 * Before `rootName` is set overdefined, mark COPY-derived aliases overdefined
 * transitively along forward copy edges only (dest COPY where payload names the
 * invalidated slot). Does not walk “backward” to unrelated sibling copies of
 * a shared source. Caller must `setOverdefined(rootName)` after this returns.
 */
const invalidateCopyAliasesOfRoot = (
  lattice: CompactLattice,
  varIds: VariableIdMap,
  rootName: string,
): void => {
  const queue: string[] = [rootName];
  const seen = new Set<string>([rootName]);
  let head = 0;
  while (head < queue.length) {
    const n = queue[head++] as string;
    varIds.forEachName((destName) => {
      const id = varIds.tryGetId(destName);
      if (id === -1) return;
      if (lattice.kinds[id] !== KIND_COPY) return;
      const payload = lattice.payloads.get(id);
      if (!payload) return;
      if ((payload as VariableOperand).name !== n) return;
      lattice.setOverdefined(destName);
      if (!seen.has(destName)) {
        seen.add(destName);
        queue.push(destName);
      }
    });
  }
};

const resolveLatticeOperandCompact = (
  operand: TACOperand,
  lattice: CompactLattice,
  varIds: VariableIdMap,
): TACOperand => {
  if (operand.kind === TACOperandKind.Constant) return operand;
  if (
    operand.kind !== TACOperandKind.Variable &&
    operand.kind !== TACOperandKind.Temporary
  ) {
    return operand;
  }

  const original = operand;
  let current: VariableOperand =
    operand.kind === TACOperandKind.Variable
      ? (operand as VariableOperand)
      : createVariable(
          temporaryLatticeKey((operand as TemporaryOperand).id),
          (operand as TemporaryOperand).type,
        );

  let steps = lattice.payloadCount + 1;
  while (steps-- > 0) {
    const id = varIds.tryGetId(current.name);
    if (id === -1) {
      // All operands reachable via copy chains are pre-registered; −1 only
      // means the *initial* operand never appeared in any instruction.
      return original;
    }
    const kind = lattice.kinds[id];
    if (kind === KIND_UNKNOWN || kind === KIND_OVERDEFINED) {
      return resolveNonConstantOperand(original, current);
    }
    if (kind === KIND_CONSTANT) {
      const payload = lattice.payloads.get(id);
      return payload
        ? (payload as ConstantOperand)
        : resolveNonConstantOperand(original, current);
    }
    // KIND_COPY
    const payload = lattice.payloads.get(id);
    if (!payload) {
      return resolveNonConstantOperand(original, current);
    }
    current = payload as VariableOperand;
  }
  return latticeVariableToTacOperand(current);
};

const transferCompactLattice = (
  lattice: CompactLattice,
  inst: TACInstruction,
  varIds: VariableIdMap,
): void => {
  if (
    inst.kind === TACInstructionKind.Assignment ||
    inst.kind === TACInstructionKind.Copy
  ) {
    const { dest, src } = inst as unknown as InstWithDestSrc;
    if (
      dest.kind !== TACOperandKind.Variable &&
      dest.kind !== TACOperandKind.Temporary
    ) {
      return;
    }
    const destName = latticeNameForOperand(dest);
    if (destName === null) return;

    const resolvedConst = resolveLatticeConstantCompact(src, lattice, varIds);
    if (resolvedConst) {
      lattice.setConstant(destName, resolvedConst);
    } else if (
      src.kind === TACOperandKind.Variable ||
      src.kind === TACOperandKind.Temporary
    ) {
      const srcVar: VariableOperand =
        src.kind === TACOperandKind.Variable
          ? (src as VariableOperand)
          : createVariable(
              temporaryLatticeKey((src as TemporaryOperand).id),
              (src as TemporaryOperand).type,
            );
      const srcInfo = lattice.get(srcVar.name);
      if (srcInfo.kind === "overdefined") {
        lattice.setOverdefined(destName);
        return;
      }
      // Check if adding dest -> copy(src) would create a cycle
      let isCycle = false;
      let steps = lattice.payloadCount + 1;
      let cur: VariableOperand | null = srcVar;
      while (cur && steps-- > 0) {
        if (cur.name === destName) {
          isCycle = true;
          break;
        }
        const info = lattice.get(cur.name);
        if (info.kind !== "copy") break;
        cur = info.operand;
      }
      if (steps < 0) isCycle = true;
      if (isCycle) {
        lattice.setOverdefined(destName);
      } else {
        lattice.setCopy(destName, srcVar);
      }
    } else {
      lattice.setOverdefined(destName);
    }
    return;
  }

  if (inst.kind === TACInstructionKind.PropertySet) {
    const set = inst as PropertySetInstruction;
    const name = latticeNameForOperand(set.object);
    if (name !== null) {
      invalidateCopyAliasesOfRoot(lattice, varIds, name);
      lattice.setOverdefined(name);
    }
    return;
  }

  if (inst.kind === TACInstructionKind.ArrayAssignment) {
    const assign = inst as ArrayAssignmentInstruction;
    const name = latticeNameForOperand(assign.array);
    if (name !== null) {
      invalidateCopyAliasesOfRoot(lattice, varIds, name);
      lattice.setOverdefined(name);
    }
    return;
  }

  if (inst.kind === TACInstructionKind.MethodCall) {
    const call = inst as MethodCallInstruction;
    if (isCopyOnWriteCandidateType(getOperandType(call.object))) {
      const name = latticeNameForOperand(call.object);
      if (name !== null) {
        invalidateCopyAliasesOfRoot(lattice, varIds, name);
        lattice.setOverdefined(name);
      }
    }
    // fall through to clear any defined variable via getDefinedOperandForReuse
  }

  const defined = getDefinedOperandForReuse(inst);
  if (defined) {
    const name = latticeNameForOperand(defined);
    if (name !== null) {
      invalidateCopyAliasesOfRoot(lattice, varIds, name);
      lattice.setOverdefined(name);
    }
  }
};

const replaceInstructionWithLatticeMap = (
  inst: TACInstruction,
  lattice: CompactLattice,
  varIds: VariableIdMap,
): TACInstruction => {
  const replace = (operand: TACOperand): TACOperand =>
    resolveLatticeOperandCompact(operand, lattice, varIds);

  switch (inst.kind) {
    case TACInstructionKind.BinaryOp: {
      const bin = inst as BinaryOpInstruction;
      const left = replace(bin.left);
      const right = replace(bin.right);
      if (left !== bin.left || right !== bin.right) {
        return new (bin.constructor as typeof BinaryOpInstruction)(
          bin.dest,
          left,
          bin.operator,
          right,
        );
      }
      return inst;
    }
    case TACInstructionKind.UnaryOp: {
      const un = inst as UnaryOpInstruction;
      const operand = replace(un.operand);
      if (operand !== un.operand) {
        return new (un.constructor as typeof UnaryOpInstruction)(
          un.dest,
          un.operator,
          operand,
        );
      }
      return inst;
    }
    case TACInstructionKind.Assignment:
    case TACInstructionKind.Copy: {
      const { dest, src } = inst as unknown as InstWithDestSrc;
      const resolved = replace(src);
      if (resolved !== src) {
        if (inst.kind === TACInstructionKind.Copy) {
          return new CopyInstruction(dest, resolved);
        }
        return new AssignmentInstruction(dest, resolved);
      }
      return inst;
    }
    case TACInstructionKind.Cast: {
      const castInst = inst as CastInstruction;
      const resolved = replace(castInst.src);
      if (resolved !== castInst.src) {
        return new (castInst.constructor as typeof CastInstruction)(
          castInst.dest,
          resolved,
        );
      }
      return inst;
    }
    case TACInstructionKind.ConditionalJump: {
      const cond = inst as ConditionalJumpInstruction;
      const condition = replace(cond.condition);
      if (condition !== cond.condition) {
        return new (cond.constructor as typeof ConditionalJumpInstruction)(
          condition,
          cond.label,
        );
      }
      return inst;
    }
    case TACInstructionKind.Call: {
      const call = inst as CallInstruction;
      const args = call.args.map((arg) => replace(arg));
      if (args.some((arg, idx) => arg !== call.args[idx])) {
        return new (call.constructor as typeof CallInstruction)(
          call.dest,
          call.func,
          args,
          call.isTailCall,
        );
      }
      return inst;
    }
    case TACInstructionKind.MethodCall: {
      const call = inst as MethodCallInstruction;
      // Do not copy-propagate the receiver: may be a CoW temp or mutation target.
      const object = call.object;
      const args = call.args.map((arg) => replace(arg));
      if (args.some((arg, idx) => arg !== call.args[idx])) {
        return new (call.constructor as typeof MethodCallInstruction)(
          call.dest,
          object,
          call.method,
          args,
          call.isTailCall,
        );
      }
      return inst;
    }
    case TACInstructionKind.PropertyGet: {
      const get = inst as PropertyGetInstruction;
      const object = replace(get.object);
      if (object !== get.object) {
        return new (get.constructor as typeof PropertyGetInstruction)(
          get.dest,
          object,
          get.property,
        );
      }
      return inst;
    }
    case TACInstructionKind.PropertySet: {
      const set = inst as PropertySetInstruction;
      // Do not copy-propagate the receiver: mutating through a forwarded alias
      // would collapse CoW patterns (Copy then PropertySet on the copy).
      const object = set.object;
      const value = replace(set.value);
      if (value !== set.value) {
        return new (set.constructor as typeof PropertySetInstruction)(
          object,
          set.property,
          value,
        );
      }
      return inst;
    }
    case TACInstructionKind.Return: {
      const ret = inst as ReturnInstruction;
      if (ret.value) {
        const value = replace(ret.value);
        if (value !== ret.value) {
          return new (ret.constructor as typeof ReturnInstruction)(
            value,
            ret.returnVarName,
          );
        }
      }
      return inst;
    }
    case TACInstructionKind.ArrayAccess: {
      const access = inst as ArrayAccessInstruction;
      const array = replace(access.array);
      const index = replace(access.index);
      if (array !== access.array || index !== access.index) {
        return new (access.constructor as typeof ArrayAccessInstruction)(
          access.dest,
          array,
          index,
        );
      }
      return inst;
    }
    case TACInstructionKind.ArrayAssignment: {
      const assign = inst as ArrayAssignmentInstruction;
      const array = assign.array;
      const index = replace(assign.index);
      const value = replace(assign.value);
      if (index !== assign.index || value !== assign.value) {
        return new (assign.constructor as typeof ArrayAssignmentInstruction)(
          array,
          index,
          value,
        );
      }
      return inst;
    }
    default:
      return inst;
  }
};

/**
 * Sparse Conditional Constant Propagation with dead-code pruning.
 *
 * Uses a single global lattice (no SSA phi functions) with worklist-driven
 * propagation.  Sound but may be imprecise for variables defined across
 * multiple paths — those are conservatively marked overdefined.
 */
export const sccpAndPrune = (
  instructions: TACInstruction[],
  exposedLabels?: Set<string>,
  options?: {
    maxWorklistIterations?: number;
    onLimitReached?: "markAllReachable" | "break" | "warn";
  } & CFGPassOptions,
): PassResult => {
  const cfg = options?.cachedCFG ?? buildCFG(instructions);
  if (cfg.blocks.length === 0) return { instructions, changed: false };

  // Pre-scan: build variable ID map (includes synthetic temp lattice keys)
  const varIds = new VariableIdMap();
  for (const inst of instructions) {
    const defined = getDefinedOperandForReuse(inst);
    const defName = defined ? latticeNameForOperand(defined) : null;
    if (defName !== null) {
      varIds.register(defName);
    }
    forEachUsedOperand(inst, (op) => {
      const n = latticeNameForOperand(op);
      if (n !== null) {
        varIds.register(n);
      }
    });
  }
  const numVars = varIds.size;

  const labelToBlock = new Map<string, number>();
  for (const block of cfg.blocks) {
    for (let i = block.start; i <= block.end; i++) {
      const inst = instructions[i];
      if (inst.kind !== TACInstructionKind.Label) continue;
      const labelInst = inst as LabelInstruction;
      if (labelInst.label.kind !== TACOperandKind.Label) continue;
      labelToBlock.set((labelInst.label as LabelOperand).name, block.id);
    }
  }

  // Build varUseBlocks: for each variable ID, which blocks use (read) it
  const numBlocks = cfg.blocks.length;
  const varUseBlocks: number[][] = new Array(numVars);
  for (let i = 0; i < numVars; i++) varUseBlocks[i] = [];
  for (const block of cfg.blocks) {
    const usedInBlock = new Set<number>();
    for (let i = block.start; i <= block.end; i++) {
      forEachUsedOperand(instructions[i], (op) => {
        const n = latticeNameForOperand(op);
        if (n !== null) {
          const id = varIds.tryGetId(n);
          if (id !== -1) usedInBlock.add(id);
        }
      });
    }
    for (const varId of usedInBlock) {
      varUseBlocks[varId].push(block.id);
    }
  }

  // Global lattice: single copy, O(V) memory instead of O(B*V)
  const globalKinds = new Uint8Array(numVars); // all KIND_UNKNOWN (0)
  const globalPayloads = new Map<number, ConstantOperand | VariableOperand>();
  const localLattice = new CompactLattice(numVars, varIds);

  // Use Uint8Array flags instead of Set<number> for O(1) access
  const reachable = new Uint8Array(numBlocks);
  const inQueueFlags = new Uint8Array(numBlocks);

  const queue: number[] = [];
  let qHead = 0;
  const enqueue = (id: number): void => {
    if (!inQueueFlags[id]) {
      inQueueFlags[id] = 1;
      queue.push(id);
    }
  };

  // entry block always reachable
  reachable[0] = 1;
  enqueue(0);

  // Also mark explicitly-exposed labels reachable so they won't be pruned
  if (exposedLabels && exposedLabels.size > 0) {
    for (const lbl of exposedLabels) {
      const b = labelToBlock.get(lbl);
      if (b !== undefined && !reachable[b]) {
        reachable[b] = 1;
        enqueue(b);
      }
    }
  }

  const maxIterations =
    options?.maxWorklistIterations ?? Math.max(1000, cfg.blocks.length * 1000);
  const onLimit = options?.onLimitReached ?? "markAllReachable";
  let workIterations = 0;

  while (qHead < queue.length) {
    const blockId = queue[qHead++] as number;
    inQueueFlags[blockId] = 0;
    // Prevent unbounded queue growth: periodically compact the array-backed
    // queue when the head advances far enough.
    if (qHead > WORKLIST_COMPACT_THRESHOLD) {
      queue.copyWithin(0, qHead);
      queue.length -= qHead;
      qHead = 0;
    }

    // Skip if block became unreachable (shouldn't happen, but defensive)
    if (!reachable[blockId]) continue;

    const block = cfg.blocks[blockId];

    // Count iterations
    if (++workIterations > maxIterations) {
      if (onLimit === "warn") {
        try {
          console.warn(
            `sccpAndPrune: reached maxWorklistIterations=${maxIterations}; aborting early`,
          );
        } catch (_e) {
          /* ignore */
        }
      }
      if (onLimit === "markAllReachable") {
        for (const b of cfg.blocks) reachable[b.id] = 1;
      }
      break;
    }

    // Reset local lattice from global state
    localLattice.resetFrom(globalKinds, globalPayloads);

    // Transfer through all instructions in this block
    for (let i = block.start; i <= block.end; i++) {
      transferCompactLattice(localLattice, instructions[i], varIds);
    }

    // Meet dirty local values into global lattice
    const changedVarIds: number[] = [];
    for (const varId of localLattice.dirty) {
      const localKind = localLattice.kinds[varId];
      const localPayload = localLattice.payloads.get(varId);
      if (
        meetIntoGlobal(
          varId,
          localKind,
          localPayload,
          globalKinds,
          globalPayloads,
        )
      ) {
        changedVarIds.push(varId);
      }
    }

    // Resolve reachable successors using local lattice for branch evaluation
    const succs = resolveReachableSuccs(
      block,
      instructions,
      labelToBlock,
      (operand) => resolveLatticeConstantCompact(operand, localLattice, varIds),
      numBlocks,
    );
    for (const succ of succs) {
      if (!reachable[succ]) {
        reachable[succ] = 1;
        enqueue(succ);
      }
    }

    // If any global lattice value changed, enqueue blocks that use the changed variables
    for (const varId of changedVarIds) {
      for (const useBlock of varUseBlocks[varId]) {
        if (reachable[useBlock]) {
          enqueue(useBlock);
        }
      }
    }
  }

  // Emission: replace operands and fold branches using converged global lattice
  const result: TACInstruction[] = [];
  let didChange = false;
  let jumpTopologyChanged = false;
  for (const block of cfg.blocks) {
    if (!reachable[block.id]) continue;
    localLattice.resetFrom(globalKinds, globalPayloads);
    for (let i = block.start; i <= block.end; i++) {
      const original = instructions[i];
      const inst = replaceInstructionWithLatticeMap(
        original,
        localLattice,
        varIds,
      );
      if (inst !== original) didChange = true;

      if (inst.kind === TACInstructionKind.ConditionalJump) {
        const condInst = inst as ConditionalJumpInstruction;
        const condConst = resolveLatticeConstantCompact(
          condInst.condition,
          localLattice,
          varIds,
        );
        const truthy = condConst ? isTruthyConstant(condConst.value) : null;
        if (truthy === false) {
          result.push(new UnconditionalJumpInstruction(condInst.label));
          didChange = true;
          jumpTopologyChanged = true;
        } else if (truthy === true) {
          // Always true; skip conditional jump (fallthrough).
          didChange = true;
          jumpTopologyChanged = true;
        } else {
          result.push(inst);
        }
      } else {
        result.push(inst);
      }

      transferCompactLattice(localLattice, instructions[i], varIds);
    }
  }

  // Detect if unreachable blocks were pruned
  const prunedUnreachable = result.length !== instructions.length;
  if (prunedUnreachable) didChange = true;

  return {
    instructions: result,
    changed: didChange,
    structurallyChanged: jumpTopologyChanged || prunedUnreachable || undefined,
  };
};
