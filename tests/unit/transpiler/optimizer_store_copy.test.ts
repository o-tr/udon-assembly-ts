import { describe, expect, it } from "vitest";
import { PrimitiveTypes } from "../../../src/transpiler/frontend/type_symbols";
import { TACOptimizer } from "../../../src/transpiler/ir/optimizer/index.js";
import {
  CallInstruction,
  CopyInstruction,
  ReturnInstruction,
  TACInstructionKind,
} from "../../../src/transpiler/ir/tac_instruction";
import {
  createTemporary,
  createVariable,
  TACOperandKind,
} from "../../../src/transpiler/ir/tac_operand";

describe("store-copy optimization", () => {
  it("forwards pure call result into final variable", () => {
    const t0 = createTemporary(0, PrimitiveTypes.single);
    const a = createVariable("a", PrimitiveTypes.single, { isLocal: true });
    const x = createVariable("x", PrimitiveTypes.single, { isLocal: true });
    const pureExtern = "UnityEngineMathf.__Abs__SystemSingle__SystemSingle";

    const instructions = [
      new CallInstruction(t0, pureExtern, [x]),
      new CopyInstruction(a, t0),
      new ReturnInstruction(a),
    ];

    const optimized = new TACOptimizer().optimize(instructions);

    // Forwarding should eliminate the temp->variable copy.
    const hasCopyFromTempToVar = optimized.some((inst) => {
      if (inst.kind !== TACInstructionKind.Copy) return false;
      const copy = inst as CopyInstruction;
      return (
        copy.src.kind === TACOperandKind.Temporary &&
        copy.dest.kind === TACOperandKind.Variable
      );
    });

    const call = optimized.find(
      (inst) => inst.kind === TACInstructionKind.Call,
    ) as CallInstruction | undefined;

    expect(hasCopyFromTempToVar).toBe(false);
    expect(call?.dest?.kind).toBe(TACOperandKind.Variable);
  });
});
