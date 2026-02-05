import type { TACInstruction } from "../tac_instruction.js";
import { constantFolding } from "./passes/constant_folding.js";
import { sccpAndPrune } from "./passes/sccp.js";
import { booleanSimplification } from "./passes/boolean_simplification.js";
import { algebraicSimplification } from "./passes/algebraic_simplification.js";
import { globalValueNumbering } from "./passes/gvn.js";
import {
  eliminateSingleUseTemporaries,
  copyOnWriteTemporaries,
  reuseTemporaries,
  reuseLocalVariables,
} from "./passes/temp_reuse.js";
import {
  eliminateNoopCopies,
  eliminateDeadStoresCFG,
  deadCodeElimination,
  eliminateDeadTemporaries,
} from "./passes/dead_code.js";
import { simplifyJumps } from "./passes/jumps.js";
import { performLICM } from "./passes/licm.js";
import { optimizeInductionVariables } from "./passes/induction.js";

/**
 * TAC optimizer
 */
export class TACOptimizer {
  /**
   * Apply all optimization passes
   */
  optimize(instructions: TACInstruction[]): TACInstruction[] {
    let optimized = instructions;

    // Apply constant folding
    optimized = constantFolding(optimized);

    // Apply SCCP and prune unreachable blocks
    optimized = sccpAndPrune(optimized);

    // Apply boolean simplifications
    optimized = booleanSimplification(optimized);

    // Apply algebraic simplifications and redundant cast removal
    optimized = algebraicSimplification(optimized);

    // Apply global value numbering / CSE across blocks
    optimized = globalValueNumbering(optimized);

    // Eliminate single-use temporaries inside basic blocks
    optimized = eliminateSingleUseTemporaries(optimized);

    // Remove no-op copies/assignments
    optimized = eliminateNoopCopies(optimized);

    // Remove dead stores using CFG liveness
    optimized = eliminateDeadStoresCFG(optimized);

    // Apply dead code elimination
    optimized = deadCodeElimination(optimized);

    // Remove redundant jumps and thread jump chains
    optimized = simplifyJumps(optimized);

    // Hoist loop-invariant code
    optimized = performLICM(optimized);

    // Optimize simple induction variables
    optimized = optimizeInductionVariables(optimized);

    // Remove unused temporary computations
    optimized = eliminateDeadTemporaries(optimized);

    // Apply copy-on-write temporary reuse to reduce heap usage
    optimized = copyOnWriteTemporaries(optimized);

    // Reuse temporary variables to reduce heap usage
    optimized = reuseTemporaries(optimized);

    // Reuse local variables when lifetimes do not overlap
    optimized = reuseLocalVariables(optimized);

    return optimized;
  }
}
