import { describe, expect, it } from "vitest";
import { PrimitiveTypes } from "../../../src/transpiler/frontend/type_symbols";
import { TACOptimizer } from "../../../src/transpiler/ir/optimizer/index.js";
import {
  CallInstruction,
  CopyInstruction,
  ReturnInstruction,
} from "../../../src/transpiler/ir/tac_instruction";
import {
  createConstant,
  createTemporary,
  createVariable,
} from "../../../src/transpiler/ir/tac_operand";

describe("store-copy optimization", () => {
  it("forwards call result into final variable when temp is single-use", () => {
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const a = createVariable("a", PrimitiveTypes.int32);

    const instructions = [
      new CallInstruction(t0, "SomePureFunc", [
        createConstant(1, PrimitiveTypes.int32),
      ]),
      new CopyInstruction(a, t0),
      new ReturnInstruction(a),
    ];

    const optimized = new TACOptimizer().optimize(instructions);
    const text = optimized.map((i) => i.toString()).join("\n");

    // Expect no intermediate use of the temporary; final form is either
    // a direct call into `a` or a tail-call (TCO may remove the return).
    expect(text).not.toContain("= t0");
    expect(
      text.includes("a = call SomePureFunc(1)") ||
        text.includes("tail call SomePureFunc(1)"),
    ).toBe(true);
  });
});
