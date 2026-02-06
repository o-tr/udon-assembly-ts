import type { TACInstruction } from "../../tac_instruction.js";
import {
  type CallInstruction,
  type MethodCallInstruction,
  type ReturnInstruction,
  TACInstructionKind,
} from "../../tac_instruction.js";
import { sameOperand } from "../utils/operands.js";

export const optimizeTailCalls = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  const result: TACInstruction[] = [];

  for (let i = 0; i < instructions.length; i++) {
    const inst = instructions[i];

    if (
      (inst.kind === TACInstructionKind.Call ||
        inst.kind === TACInstructionKind.MethodCall) &&
      i + 1 < instructions.length &&
      instructions[i + 1].kind === TACInstructionKind.Return
    ) {
      const ret = instructions[i + 1] as ReturnInstruction;
      const call = inst as CallInstruction | MethodCallInstruction;
      if (call.dest && ret.value && sameOperand(ret.value, call.dest)) {
        // Mark as tail call but preserve both the call destination and
        // the following Return so return-value semantics remain intact.
        // We only set the IR-level hint; do not remove or elide the
        // Return here.
        call.isTailCall = true;
      }
    }

    result.push(inst);
  }

  return result;
};

export default optimizeTailCalls;
