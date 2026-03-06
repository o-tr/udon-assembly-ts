import {
  type ArrayAccessInstruction,
  type ArrayAssignmentInstruction,
  type AssignmentInstruction,
  type BinaryOpInstruction,
  type CallInstruction,
  type CastInstruction,
  type ConditionalJumpInstruction,
  type CopyInstruction,
  LabelInstruction,
  type MethodCallInstruction,
  type PhiInstruction,
  type PropertyGetInstruction,
  type PropertySetInstruction,
  ReturnInstruction,
  type TACInstruction,
  TACInstructionKind,
  type UnaryOpInstruction,
  type UnconditionalJumpInstruction,
} from "../tac_instruction.js";
import {
  type ConstantOperand,
  type ConstantValue,
  createLabel,
  type LabelOperand,
  type TACOperand,
  TACOperandKind,
  type TemporaryOperand,
  type VariableOperand,
} from "../tac_operand.js";
import { buildCFG } from "./analysis/cfg.js";
import { algebraicSimplification } from "./passes/algebraic_simplification.js";
import { optimizeBlockLayout } from "./passes/block_layout.js";
import { booleanSimplification } from "./passes/boolean_simplification.js";
import { castChainFolding } from "./passes/cast_chain_folding.js";
import { sinkCode } from "./passes/code_sinking.js";
import { deduplicateConstants } from "./passes/constant_dedup.js";
import { constantFolding } from "./passes/constant_folding.js";
import { propagateCopies } from "./passes/copy_propagation.js";
import {
  deadCodeElimination,
  eliminateDeadStoresCFG,
  eliminateDeadTemporaries,
  eliminateNoopCopies,
} from "./passes/dead_code.js";
import { simplifyDiamondPatterns } from "./passes/diamond_simplification.js";
import { doubleNegationElimination } from "./passes/double_negation.js";
import { eliminateFallthroughJumps } from "./passes/fallthrough.js";
import { globalValueNumbering } from "./passes/gvn.js";
import { optimizeInductionVariables } from "./passes/induction.js";
import { simplifyJumps } from "./passes/jumps.js";
import { computeRPO, performLICM } from "./passes/licm.js";
import { optimizeLoopStructures } from "./passes/loop_opts.js";
import { unswitchLoops } from "./passes/loop_unswitching.js";
import { narrowTypes } from "./passes/narrow_type.js";
import { negatedComparisonFusion } from "./passes/negated_comparison_fusion.js";
import { performPRE } from "./passes/pre.js";
import { reassociate } from "./passes/reassociation.js";
import { sccpAndPrune } from "./passes/sccp.js";
import { buildSSA, deconstructSSA } from "./passes/ssa.js";
import { optimizeStringConcatenation } from "./passes/string_optimization.js";
import { mergeTails } from "./passes/tail_merging.js";
import { optimizeTailCalls } from "./passes/tco.js";
import {
  copyOnWriteTemporaries,
  eliminateSingleUseTemporaries,
  reuseLocalVariables,
  reuseTemporaries,
} from "./passes/temp_reuse.js";
import { eliminateUnusedLabels } from "./passes/unused_labels.js";
import { optimizeVectorSwizzle } from "./passes/vector_opts.js";

const SSA_REACHABLE_BLOCK_LIMIT = 50_000;
// Tighter limit for the second SSA pass to avoid timeout on large codebases
const SSA_REACHABLE_BLOCK_LIMIT_SECOND = 10_000;

/** Feed a string into an FNV-1a hash without allocating intermediate strings. */
const hashStr = (h: number, s: string): number => {
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  }
  return h;
};

/** Feed a numeric value into the hash (up to 32-bit). */
const hashNum = (h: number, n: number): number => {
  h = Math.imul(h ^ (n & 0xff), 0x01000193);
  h = Math.imul(h ^ ((n >> 8) & 0xff), 0x01000193);
  h = Math.imul(h ^ ((n >> 16) & 0xff), 0x01000193);
  h = Math.imul(h ^ ((n >> 24) & 0xff), 0x01000193);
  return h;
};

/** Hash a single byte tag (for separators, booleans, kind discriminants). */
const hashByte = (h: number, b: number): number =>
  Math.imul(h ^ (b & 0xff), 0x01000193);

/** Hash a constant value without string allocation (except for object JSON). */
const hashConstantValue = (h: number, value: ConstantValue): number => {
  if (value === null) return hashByte(h, 0x00);
  switch (typeof value) {
    case "number":
      return hashNum(hashByte(h, 0x01), value);
    case "string":
      return hashStr(hashByte(h, 0x02), value);
    case "boolean":
      return hashByte(hashByte(h, 0x03), value ? 1 : 0);
    case "bigint":
      return hashStr(hashByte(h, 0x04), value.toString());
    default:
      // object – Record<string, number> | number[]
      return hashStr(hashByte(h, 0x05), JSON.stringify(value));
  }
};

/** Hash a TAC operand structurally. */
const hashOperand = (h: number, op: TACOperand): number => {
  switch (op.kind) {
    case TACOperandKind.Variable:
      return hashStr(hashByte(h, 0x10), (op as VariableOperand).name);
    case TACOperandKind.Temporary:
      return hashNum(hashByte(h, 0x11), (op as TemporaryOperand).id);
    case TACOperandKind.Constant:
      return hashConstantValue(hashByte(h, 0x12), (op as ConstantOperand).value);
    case TACOperandKind.Label:
      return hashStr(hashByte(h, 0x13), (op as LabelOperand).name);
  }
};

/** Hash an optional operand (uses a sentinel byte for undefined). */
const hashOptOperand = (h: number, op: TACOperand | undefined): number =>
  op ? hashOperand(hashByte(h, 0x01), op) : hashByte(h, 0x00);

const computeFingerprint = (insts: TACInstruction[]): number => {
  let h = 0x811c9dc5; // FNV-1a offset basis
  h = hashNum(h, insts.length);
  for (const inst of insts) {
    // Discriminate by instruction kind index
    h = hashByte(h, inst.kind.length);
    h = hashStr(h, inst.kind);
    switch (inst.kind) {
      case TACInstructionKind.Assignment: {
        const a = inst as AssignmentInstruction;
        h = hashOperand(h, a.dest);
        h = hashOperand(h, a.src);
        break;
      }
      case TACInstructionKind.BinaryOp: {
        const b = inst as BinaryOpInstruction;
        h = hashOperand(h, b.dest);
        h = hashOperand(h, b.left);
        h = hashStr(h, b.operator);
        h = hashOperand(h, b.right);
        break;
      }
      case TACInstructionKind.UnaryOp: {
        const u = inst as UnaryOpInstruction;
        h = hashOperand(h, u.dest);
        h = hashStr(h, u.operator);
        h = hashOperand(h, u.operand);
        break;
      }
      case TACInstructionKind.Copy: {
        const c = inst as CopyInstruction;
        h = hashOperand(h, c.dest);
        h = hashOperand(h, c.src);
        break;
      }
      case TACInstructionKind.Cast: {
        const ca = inst as CastInstruction;
        h = hashOperand(h, ca.dest);
        h = hashOperand(h, ca.src);
        break;
      }
      case TACInstructionKind.ConditionalJump: {
        const cj = inst as ConditionalJumpInstruction;
        h = hashOperand(h, cj.condition);
        h = hashOperand(h, cj.label);
        break;
      }
      case TACInstructionKind.UnconditionalJump: {
        const uj = inst as UnconditionalJumpInstruction;
        h = hashOperand(h, uj.label);
        break;
      }
      case TACInstructionKind.Label: {
        const li = inst as LabelInstruction;
        h = hashOperand(h, li.label);
        break;
      }
      case TACInstructionKind.Call: {
        const cl = inst as CallInstruction;
        h = hashOptOperand(h, cl.dest);
        h = hashStr(h, cl.func);
        h = hashNum(h, cl.args.length);
        for (const arg of cl.args) h = hashOperand(h, arg);
        h = hashByte(h, cl.isTailCall ? 1 : 0);
        break;
      }
      case TACInstructionKind.MethodCall: {
        const mc = inst as MethodCallInstruction;
        h = hashOptOperand(h, mc.dest);
        h = hashOperand(h, mc.object);
        h = hashStr(h, mc.method);
        h = hashNum(h, mc.args.length);
        for (const arg of mc.args) h = hashOperand(h, arg);
        h = hashByte(h, mc.isTailCall ? 1 : 0);
        break;
      }
      case TACInstructionKind.PropertyGet: {
        const pg = inst as PropertyGetInstruction;
        h = hashOperand(h, pg.dest);
        h = hashOperand(h, pg.object);
        h = hashStr(h, pg.property);
        break;
      }
      case TACInstructionKind.PropertySet: {
        const ps = inst as PropertySetInstruction;
        h = hashOperand(h, ps.object);
        h = hashStr(h, ps.property);
        h = hashOperand(h, ps.value);
        break;
      }
      case TACInstructionKind.Return: {
        const r = inst as ReturnInstruction;
        h = hashOptOperand(h, r.value);
        if (r.returnVarName) h = hashStr(hashByte(h, 0x01), r.returnVarName);
        else h = hashByte(h, 0x00);
        break;
      }
      case TACInstructionKind.ArrayAccess: {
        const aa = inst as ArrayAccessInstruction;
        h = hashOperand(h, aa.dest);
        h = hashOperand(h, aa.array);
        h = hashOperand(h, aa.index);
        break;
      }
      case TACInstructionKind.ArrayAssignment: {
        const aas = inst as ArrayAssignmentInstruction;
        h = hashOperand(h, aas.array);
        h = hashOperand(h, aas.index);
        h = hashOperand(h, aas.value);
        break;
      }
      case TACInstructionKind.Phi: {
        const phi = inst as PhiInstruction;
        h = hashOperand(h, phi.dest);
        h = hashNum(h, phi.sources.length);
        for (const src of phi.sources) {
          h = hashNum(h, src.pred);
          h = hashOperand(h, src.value);
        }
        break;
      }
    }
    // Separator between instructions
    h = hashByte(h, 0xff);
  }
  return h | 0;
};

/**
 * TAC optimizer
 */
export class TACOptimizer {
  /**
   * Ensure all labels referenced by jumps have corresponding definitions.
   * Missing labels get a halt stub appended at the end of the instruction stream.
   */
  private ensureLabelIntegrity(
    instructions: TACInstruction[],
  ): TACInstruction[] {
    const definedLabels = new Set<string>();
    const referencedLabels = new Set<string>();

    for (const inst of instructions) {
      if (inst.kind === TACInstructionKind.Label) {
        const labelInst = inst as LabelInstruction;
        if (labelInst.label.kind === TACOperandKind.Label) {
          definedLabels.add((labelInst.label as LabelOperand).name);
        }
      } else if (inst.kind === TACInstructionKind.ConditionalJump) {
        const jumpInst = inst as ConditionalJumpInstruction;
        if (jumpInst.label.kind === TACOperandKind.Label) {
          referencedLabels.add((jumpInst.label as LabelOperand).name);
        } else {
          console.warn(
            `ensureLabelIntegrity: ConditionalJump has non-label operand kind '${jumpInst.label.kind}'; skipping integrity check for this jump`,
          );
        }
      } else if (inst.kind === TACInstructionKind.UnconditionalJump) {
        const jumpInst = inst as UnconditionalJumpInstruction;
        if (jumpInst.label.kind === TACOperandKind.Label) {
          referencedLabels.add((jumpInst.label as LabelOperand).name);
        } else {
          console.warn(
            `ensureLabelIntegrity: UnconditionalJump has non-label operand kind '${jumpInst.label.kind}'; skipping integrity check for this jump`,
          );
        }
      }
    }

    // Find missing labels
    const missingLabels: string[] = [];
    for (const label of referencedLabels) {
      if (!definedLabels.has(label)) {
        missingLabels.push(label);
      }
    }

    if (missingLabels.length === 0) return instructions;

    const result = [...instructions];

    // Emit each missing label followed by a void return (becomes JUMP 0xFFFFFFFC
    // in Udon — return to caller). This is dead code that should never execute;
    // the stub exists only to satisfy label resolution. Udon VM has no trap/abort
    // instruction, so returning to caller is the safest fallback.
    for (const labelName of missingLabels) {
      console.warn(
        `Missing label definition for '${labelName}', inserting halt stub`,
      );
      result.push(new LabelInstruction(createLabel(labelName)));
      result.push(new ReturnInstruction());
    }

    return result;
  }

  /**
   * Apply all optimization passes
   */
  optimize(
    instructions: TACInstruction[],
    exposedLabels?: Set<string>,
  ): TACInstruction[] {
    const MAX_ITERATIONS = 3;
    let optimized = instructions;

    const runAnalysisPasses = (
      current: TACInstruction[],
      runExpensivePasses: boolean,
      iteration: number,
    ): TACInstruction[] => {
      let next = current;

      // Apply constant folding
      next = constantFolding(next);
      // Coalesce string concatenation chains
      next = optimizeStringConcatenation(next);
      // Apply SCCP and prune unreachable blocks (preserve exposedLabels)
      next = sccpAndPrune(next, exposedLabels);
      // Apply boolean simplifications
      next = booleanSimplification(next);
      // Simplify diamond patterns (ternary true/false → copy of condition)
      next = simplifyDiamondPatterns(next);
      // Fuse negated comparisons
      next = negatedComparisonFusion(next);
      // Eliminate double negations
      next = doubleNegationElimination(next);
      // Apply algebraic simplifications and redundant cast removal
      next = algebraicSimplification(next);
      // Fold cast chains
      next = castChainFolding(next);
      // Eliminate redundant widening casts used only in comparisons
      next = narrowTypes(next);
      // Reassociate partially-constant binary operations
      next = reassociate(next);
      // SSA window: build SSA, run SSA-aware passes, then deconstruct
      if (runExpensivePasses) {
        // Check reachable block count before SSA to avoid OOM on huge CFGs.
        // Use a tighter limit on the second pass to prevent timeouts.
        const ssaBlockLimit =
          iteration === 0
            ? SSA_REACHABLE_BLOCK_LIMIT
            : SSA_REACHABLE_BLOCK_LIMIT_SECOND;
        const ssaCfg = buildCFG(next);
        const rpo = computeRPO(ssaCfg);
        if (rpo.length > ssaBlockLimit) {
          console.warn(
            `Skipping SSA window: ${rpo.length} reachable blocks exceeds limit of ${ssaBlockLimit}`,
          );
        } else {
          const ssa = buildSSA(next);
          const ssaPre = performPRE(ssa, { useSSA: true });
          const ssaGvn = globalValueNumbering(ssaPre, { useSSA: true });
          next = deconstructSSA(ssaGvn);
        }
      }
      // Optimize tail calls (call followed immediately by return)
      next = optimizeTailCalls(next);
      // Eliminate single-use temporaries inside basic blocks
      next = eliminateSingleUseTemporaries(next);
      // Remove no-op copies/assignments
      next = eliminateNoopCopies(next);
      // Propagate copies within basic blocks
      next = propagateCopies(next);
      // Remove dead stores using CFG liveness
      next = eliminateDeadStoresCFG(next);
      // Apply dead code elimination
      next = deadCodeElimination(next);
      // Sink computations closer to their only use
      next = sinkCode(next);
      // Reorder basic blocks to reduce jumps
      next = optimizeBlockLayout(next);
      // Remove jumps that fall through to the next label
      next = eliminateFallthroughJumps(next);
      // Remove redundant jumps and thread jump chains
      next = simplifyJumps(next);
      if (runExpensivePasses) {
        // Hoist loop-invariant code
        next = performLICM(next);
        // Unswitch loops with loop-invariant conditionals
        next = unswitchLoops(next);
        // Optimize simple induction variables
        next = optimizeInductionVariables(next);
        // Unroll simple fixed-count loops
        next = optimizeLoopStructures(next);
        // Fold scalar Vector3 updates into vector ops
        next = optimizeVectorSwizzle(next);
      }

      // Remove unused temporary computations
      next = eliminateDeadTemporaries(next);
      // Merge identical return tails
      next = mergeTails(next);
      // Remove unused labels (preserve externally exposed labels)
      next = eliminateUnusedLabels(next, exposedLabels);
      return next;
    };

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const beforeLen = optimized.length;
      const beforeHash = computeFingerprint(optimized);
      optimized = runAnalysisPasses(optimized, iteration <= 1, iteration);
      if (
        optimized.length === beforeLen &&
        computeFingerprint(optimized) === beforeHash
      ) {
        break;
      }
    }

    // Ensure all referenced labels have definitions before temp-reuse passes
    optimized = this.ensureLabelIntegrity(optimized);

    // Deduplicate temporaries holding the same constant value
    optimized = deduplicateConstants(optimized);

    // Apply copy-on-write temporary reuse to reduce heap usage
    optimized = copyOnWriteTemporaries(optimized);

    // Reuse temporary variables to reduce heap usage
    optimized = reuseTemporaries(optimized);

    // Reuse local variables when lifetimes do not overlap
    optimized = reuseLocalVariables(optimized);

    // Final label integrity check after all passes
    optimized = this.ensureLabelIntegrity(optimized);

    return optimized;
  }
}
