import {
  type ConditionalJumpInstruction,
  LabelInstruction,
  ReturnInstruction,
  type TACInstruction,
  TACInstructionKind,
  type UnconditionalJumpInstruction,
} from "../tac_instruction.js";
import {
  createLabel,
  type LabelOperand,
  TACOperandKind,
} from "../tac_operand.js";
import { buildCFG } from "./analysis/cfg.js";
import type { CFG, PassResult } from "./pass_types.js";
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

const computeFingerprint = (insts: TACInstruction[]): number => {
  // FNV-1a 32-bit hash
  let h = 0x811c9dc5;
  h = Math.imul(h ^ (insts.length & 0xff), 0x01000193);
  h = Math.imul(h ^ ((insts.length >> 8) & 0xff), 0x01000193);
  for (const inst of insts) {
    const s = inst.toString();
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    }
    // Separator to distinguish "ab"+"cd" from "a"+"bcd"
    h = Math.imul(h ^ 0x0a, 0x01000193);
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
      let cachedCFG: CFG | null = null;

      const run = (result: PassResult): void => {
        next = result.instructions;
        if (result.changed) cachedCFG = null;
      };

      const getCFG = (): CFG => {
        if (!cachedCFG) cachedCFG = buildCFG(next);
        return cachedCFG;
      };

      // Apply constant folding
      run(constantFolding(next));
      // Coalesce string concatenation chains
      run(optimizeStringConcatenation(next));
      // Apply SCCP and prune unreachable blocks (preserve exposedLabels)
      run(sccpAndPrune(next, exposedLabels, { cachedCFG: getCFG() }));
      // Apply boolean simplifications
      run(booleanSimplification(next));
      // Simplify diamond patterns (ternary true/false → copy of condition)
      run(simplifyDiamondPatterns(next));
      // Fuse negated comparisons
      run(negatedComparisonFusion(next));
      // Eliminate double negations
      run(doubleNegationElimination(next));
      // Apply algebraic simplifications and redundant cast removal
      run(algebraicSimplification(next));
      // Fold cast chains
      run(castChainFolding(next));
      // Eliminate redundant widening casts used only in comparisons
      run(narrowTypes(next));
      // Reassociate partially-constant binary operations
      run(reassociate(next));
      // SSA window: build SSA, run SSA-aware passes, then deconstruct
      if (runExpensivePasses) {
        // Check reachable block count before SSA to avoid OOM on huge CFGs.
        // Use a tighter limit on the second pass to prevent timeouts.
        const ssaBlockLimit =
          iteration === 0
            ? SSA_REACHABLE_BLOCK_LIMIT
            : SSA_REACHABLE_BLOCK_LIMIT_SECOND;
        const ssaCfg = getCFG();
        const rpo = computeRPO(ssaCfg);
        if (rpo.length > ssaBlockLimit) {
          console.warn(
            `Skipping SSA window: ${rpo.length} reachable blocks exceeds limit of ${ssaBlockLimit}`,
          );
        } else {
          const ssa = buildSSA(next, { cachedCFG: getCFG() });
          const ssaPre = performPRE(ssa.instructions, { useSSA: true });
          const ssaGvn = globalValueNumbering(ssaPre.instructions, {
            useSSA: true,
          });
          next = deconstructSSA(ssaGvn.instructions).instructions;
          // Always invalidate after SSA window
          cachedCFG = null;
        }
      }
      // Optimize tail calls (call followed immediately by return)
      run(optimizeTailCalls(next));
      // Eliminate single-use temporaries inside basic blocks
      run(eliminateSingleUseTemporaries(next, { cachedCFG: getCFG() }));
      // Remove no-op copies/assignments
      run(eliminateNoopCopies(next));
      // Propagate copies within basic blocks
      run(propagateCopies(next, { cachedCFG: getCFG() }));
      // Remove dead stores using CFG liveness
      run(eliminateDeadStoresCFG(next, { cachedCFG: getCFG() }));
      // Apply dead code elimination
      run(deadCodeElimination(next));
      // Sink computations closer to their only use
      run(sinkCode(next, { cachedCFG: getCFG() }));
      // Reorder basic blocks to reduce jumps
      run(optimizeBlockLayout(next, { cachedCFG: getCFG() }));
      // Remove jumps that fall through to the next label
      run(eliminateFallthroughJumps(next));
      // Remove redundant jumps and thread jump chains
      run(simplifyJumps(next));
      if (runExpensivePasses) {
        // Hoist loop-invariant code
        run(performLICM(next, { cachedCFG: getCFG() }));
        // Unswitch loops with loop-invariant conditionals
        run(unswitchLoops(next));
        // Optimize simple induction variables
        run(optimizeInductionVariables(next, { cachedCFG: getCFG() }));
        // Unroll simple fixed-count loops
        run(optimizeLoopStructures(next));
        // Fold scalar Vector3 updates into vector ops
        run(optimizeVectorSwizzle(next));
      }

      // Remove unused temporary computations
      run(eliminateDeadTemporaries(next));
      // Merge identical return tails
      run(mergeTails(next));
      // Remove unused labels (preserve externally exposed labels)
      run(eliminateUnusedLabels(next, exposedLabels));
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

    {
      let postCFG: CFG | null = null;
      const getPostCFG = (): CFG => {
        if (!postCFG) postCFG = buildCFG(optimized);
        return postCFG;
      };
      const runPost = (result: PassResult): void => {
        optimized = result.instructions;
        if (result.changed) postCFG = null;
      };

      // Deduplicate temporaries holding the same constant value
      runPost(deduplicateConstants(optimized));

      // Apply copy-on-write temporary reuse to reduce heap usage
      runPost(copyOnWriteTemporaries(optimized, { cachedCFG: getPostCFG() }));

      // Reuse temporary variables to reduce heap usage
      runPost(reuseTemporaries(optimized, { cachedCFG: getPostCFG() }));

      // Reuse local variables when lifetimes do not overlap
      runPost(reuseLocalVariables(optimized, { cachedCFG: getPostCFG() }));
    }

    // Final label integrity check after all passes
    optimized = this.ensureLabelIntegrity(optimized);

    return optimized;
  }
}
