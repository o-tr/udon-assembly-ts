import { describe, expect, it } from "vitest";
import { PrimitiveTypes } from "../../../src/transpiler/frontend/type_symbols";
import {
  buildSSA,
  deconstructSSA,
} from "../../../src/transpiler/ir/optimizer/passes/ssa";
import {
  AssignmentInstruction,
  BinaryOpInstruction,
  ConditionalJumpInstruction,
  LabelInstruction,
  ReturnInstruction,
  TACInstructionKind,
  UnconditionalJumpInstruction,
} from "../../../src/transpiler/ir/tac_instruction";
import {
  createConstant,
  createLabel,
  createTemporary,
  createVariable,
} from "../../../src/transpiler/ir/tac_operand";

describe("ssa pass", () => {
  it("inserts and removes phi nodes", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const cond = createVariable("cond", PrimitiveTypes.boolean);
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const lElse = createLabel("L_else");
    const lEnd = createLabel("L_end");

    const instructions = [
      new ConditionalJumpInstruction(cond, lElse),
      new AssignmentInstruction(a, createConstant(1, PrimitiveTypes.int32)),
      new UnconditionalJumpInstruction(lEnd),
      new LabelInstruction(lElse),
      new AssignmentInstruction(a, createConstant(2, PrimitiveTypes.int32)),
      new LabelInstruction(lEnd),
      new BinaryOpInstruction(
        t0,
        a,
        "+",
        createConstant(1, PrimitiveTypes.int32),
      ),
      new ReturnInstruction(t0),
    ];

    const ssa = buildSSA(instructions);
    expect(ssa.some((inst) => inst.kind === TACInstructionKind.Phi)).toBe(true);

    const lowered = deconstructSSA(ssa);
    expect(lowered.some((inst) => inst.kind === TACInstructionKind.Phi)).toBe(
      false,
    );
  });
});
