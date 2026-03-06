import type { TACInstruction } from "../tac_instruction.js";
import type { BasicBlock } from "./analysis/cfg.js";

/** Return type for all optimization passes. */
export type PassResult = {
  instructions: TACInstruction[];
  changed: boolean;
};

/** The CFG structure as returned by buildCFG. */
export type CFG = { blocks: BasicBlock[] };

/** Options for passes that can accept a cached CFG. */
export type CFGPassOptions = {
  cachedCFG?: CFG;
};
