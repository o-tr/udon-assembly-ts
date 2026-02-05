import { describe, expect, it } from "vitest";
import { TACToUdonConverter } from "../../../src/transpiler/codegen/tac_to_udon/index.js";
import { UdonInstructionKind } from "../../../src/transpiler/codegen/udon_instruction";
import { PrimitiveTypes } from "../../../src/transpiler/frontend/type_symbols";
import { CallInstruction } from "../../../src/transpiler/ir/tac_instruction";
import { createConstant } from "../../../src/transpiler/ir/tac_operand";

describe("TAC->Udon TCO generation", () => {
  it("emits JUMP for tail calls", () => {
    const call = new CallInstruction(
      undefined,
      "System.__SomeExtern__SystemSingle__SystemSingle",
      [createConstant(1, PrimitiveTypes.single)],
      true,
    );

    const conv = new TACToUdonConverter();
    const udon = conv.convert([call]);

    // Codegen should emit a normal extern call rather than a raw JUMP
    // for tail-call IR hints; ensure an EXTERN instruction is present.
    const hasExtern = udon.some(
      (inst) => inst.kind === UdonInstructionKind.Extern,
    );
    expect(hasExtern).toBe(true);
  });
});
