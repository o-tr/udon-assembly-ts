import type { TACInstruction } from "../tac_instruction.js";
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
import { performLICM } from "./passes/licm.js";
import { optimizeLoopStructures } from "./passes/loop_opts.js";
import { unswitchLoops } from "./passes/loop_unswitching.js";
import { narrowTypes } from "./passes/narrow_type.js";
import { negatedComparisonFusion } from "./passes/negated_comparison_fusion.js";
import { performPRE } from "./passes/pre.js";
import { reassociate } from "./passes/reassociation.js";
import { sccpAndPrune } from "./passes/sccp.js";
import { applySSA } from "./passes/ssa.js";
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

/**
 * TAC optimizer
 */
export class TACOptimizer {
  /**
   * Apply all optimization passes
   */
  optimize(
    instructions: TACInstruction[],
    exposedLabels?: Set<string>,
  ): TACInstruction[] {
    const MAX_ITERATIONS = 3;
    let optimized = instructions;

    const runAnalysisPasses = (current: TACInstruction[]): TACInstruction[] => {
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

      // Convert to SSA and back to enable SSA-aware analyses
      next = applySSA(next);

      // Partial redundancy elimination
      next = performPRE(next);

      // Apply global value numbering / CSE across blocks
      next = globalValueNumbering(next);

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

      // Remove unused temporary computations
      next = eliminateDeadTemporaries(next);

      // Merge identical return tails
      next = mergeTails(next);

      // Remove unused labels (preserve externally exposed labels)
      next = eliminateUnusedLabels(next, exposedLabels);

      return next;
    };

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const before = optimized.map((inst) => inst.toString()).join("\n");
      optimized = runAnalysisPasses(optimized);
      const after = optimized.map((inst) => inst.toString()).join("\n");
      if (before === after) break;
    }

    // Deduplicate temporaries holding the same constant value
    optimized = deduplicateConstants(optimized);

    // Apply copy-on-write temporary reuse to reduce heap usage
    optimized = copyOnWriteTemporaries(optimized);

    // Reuse temporary variables to reduce heap usage
    optimized = reuseTemporaries(optimized);

    // Reuse local variables when lifetimes do not overlap
    optimized = reuseLocalVariables(optimized);

    return optimized;
  }
}
