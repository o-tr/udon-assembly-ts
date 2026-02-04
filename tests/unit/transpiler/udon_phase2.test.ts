/**
 * Unit tests for Phase 2 TAC to Udon extensions
 */

import { describe, expect, it } from "vitest";
import { TACToUdonConverter } from "../../../src/transpiler/codegen/tac_to_udon";
import { UdonInstructionKind } from "../../../src/transpiler/codegen/udon_instruction";
import { PrimitiveTypes } from "../../../src/transpiler/frontend/type_symbols";
import {
  MethodCallInstruction,
  PropertyGetInstruction,
  PropertySetInstruction,
} from "../../../src/transpiler/ir/tac_instruction";
import {
  createTemporary,
  createVariable,
} from "../../../src/transpiler/ir/tac_operand";

describe("Udon Code Generation Phase 2", () => {
  it("should generate externs for property get/set and method calls", () => {
    const obj = createVariable("player", PrimitiveTypes.single);
    const temp = createTemporary(0, PrimitiveTypes.single);

    const instructions = [
      new PropertyGetInstruction(temp, obj, "Position"),
      new PropertySetInstruction(obj, "Position", temp),
      new MethodCallInstruction(temp, obj, "Reset", [temp]),
    ];

    const converter = new TACToUdonConverter();
    const udon = converter.convert(instructions);
    const externs = converter.getExternSignatures();

    expect(udon.some((inst) => inst.kind === UdonInstructionKind.Extern)).toBe(
      true,
    );
    expect(externs.some((sig) => sig.includes("get_Position"))).toBe(true);
    expect(externs.some((sig) => sig.includes("set_Position"))).toBe(true);
    expect(externs.some((sig) => sig.includes("Reset"))).toBe(true);
  });
});
