import type { TACInstruction } from "../../tac_instruction.js";
import {
  type CallInstruction,
  type MethodCallInstruction,
  type ReturnInstruction,
  TACInstructionKind,
} from "../../tac_instruction.js";
import { buildCFG } from "../analysis/cfg.js";
import { sameOperand } from "../utils/operands.js";

export const optimizeTailCalls = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  const cfg = buildCFG(instructions);
  if (cfg.blocks.length === 0) return instructions;

  const result: TACInstruction[] = [];

  for (const block of cfg.blocks) {
    const blockInst = instructions.slice(block.start, block.end + 1);
    for (let i = 0; i < blockInst.length; i++) {
      const inst = blockInst[i];

      if (
        (inst.kind === TACInstructionKind.Call ||
          inst.kind === TACInstructionKind.MethodCall) &&
        i + 1 < blockInst.length &&
        blockInst[i + 1].kind === TACInstructionKind.Return
      ) {
        const ret = blockInst[i + 1] as ReturnInstruction;
        const call = inst as CallInstruction | MethodCallInstruction;
        if (call.dest && ret.value && sameOperand(ret.value, call.dest)) {
          // Mark as tail call but preserve both the call destination and
          // the following Return so return-value semantics remain intact.
          // We only set the IR-level hint; do not remove or elide the
          // Return here.
          call.isTailCall = true;
          // Fall through and allow the normal loop tail to push `inst`
          // (the call) and then the subsequent `Return` will be processed
          // on the next iteration.
        }
      }

      result.push(inst);
    }
  }

  return result;
};

export default optimizeTailCalls;
