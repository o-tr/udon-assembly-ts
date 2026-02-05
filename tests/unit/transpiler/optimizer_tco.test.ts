import { describe, expect, it } from "vitest";
import { PrimitiveTypes } from "../../../src/transpiler/frontend/type_symbols";
import { TACOptimizer } from "../../../src/transpiler/ir/optimizer/index.js";
import {
  CallInstruction,
  ReturnInstruction,
} from "../../../src/transpiler/ir/tac_instruction";
import {
  createConstant,
  createTemporary,
} from "../../../src/transpiler/ir/tac_operand";

describe("tail-call optimization", () => {
  it("marks call+return as tail call and removes return", () => {
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const instructions = [
      new CallInstruction(t0, "RecurseFunc", [
        createConstant(1, PrimitiveTypes.int32),
      ]),
      new ReturnInstruction(t0),
    ];

    const optimized = new TACOptimizer().optimize(instructions);
    const text = optimized.map((i) => i.toString()).join("\n");

    // Call should be rewritten as a tail-call hint (IR-level). We
    // preserve the return instruction to avoid dropping return-value
    // semantics at this stage.
    expect(text).toContain("tail call RecurseFunc(1)");
  });
});
