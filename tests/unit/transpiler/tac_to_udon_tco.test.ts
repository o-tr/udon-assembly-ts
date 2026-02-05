import { describe, expect, it } from "vitest";
import { TACToUdonConverter } from "../../../src/transpiler/codegen/tac_to_udon/index.js";
import { CallInstruction } from "../../../src/transpiler/ir/tac_instruction";
import { createConstant } from "../../../src/transpiler/ir/tac_operand";
import { UdonInstructionKind } from "../../../src/transpiler/codegen/udon_instruction";

describe("TAC->Udon TCO generation", () => {
  it("emits JUMP for tail calls", () => {
    const call = new CallInstruction(
      undefined,
      "System.__SomeExtern__SystemSingle__SystemSingle",
      [createConstant(1, { udonType: "Single" })],
      true,
    );

    const conv = new TACToUdonConverter();
    const udon = conv.convert([call]);

    const hasJump = udon.some((inst) => inst.kind === UdonInstructionKind.Jump);
    expect(hasJump).toBe(true);
  });
});
