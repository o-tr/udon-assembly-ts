import type { TACInstruction } from "../tac_instruction.js";
import type { BasicBlock } from "./analysis/cfg.js";

/**
 * Safety limit for dataflow fixpoint loops.
 * Normal convergence happens in 2-5 iterations; this prevents hangs on
 * pathological inputs.  Early termination is conservatively safe for
 * forward-flow passes (GVN/PRE — fewer optimisations) but may
 * under-approximate liveness in backward passes (dead-code / temp-reuse),
 * so those callers should emit a warning when the limit is hit.
 */
export const MAX_FIXPOINT_ITERATIONS = 1000;

/** Return type for all optimization passes. */
export type PassResult = {
  instructions: TACInstruction[];
  changed: boolean;
  /** When true, the pass added or removed instructions, invalidating CFG topology. */
  structurallyChanged?: boolean;
};

/** The CFG structure as returned by buildCFG. */
export type CFG = { blocks: BasicBlock[] };

/**
 * Mutable counter that callers can thread through multiple SSA
 * deconstruction calls to guarantee label-name uniqueness across iterations.
 */
export type EdgeLabelSeed = { value: number };

/** Options for passes that can accept a cached CFG. */
export type CFGPassOptions = {
  cachedCFG?: CFG;
  /** When provided, SSA edge-block labels are numbered starting from this
   *  seed and the seed is updated in-place so successive calls stay unique. */
  edgeLabelSeed?: EdgeLabelSeed;
};
