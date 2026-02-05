import type { TACInstruction } from "../../tac_instruction.js";
import {
  type CallInstruction,
  type MethodCallInstruction,
  type ReturnInstruction,
  TACInstructionKind,
} from "../../tac_instruction.js";
import { buildCFG } from "../analysis/cfg.js";

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
        if (call.dest && ret.value && ret.value === call.dest) {
          // Mark as tail call, remove the return
          call.isTailCall = true;
          // Drop destination so codegen knows not to expect a result
          call.dest = undefined;
          result.push(call as unknown as TACInstruction);
          i += 1; // skip the return
          continue;
        }
      }

      result.push(inst);
    }
  }

  return result;
};

export default optimizeTailCalls;
