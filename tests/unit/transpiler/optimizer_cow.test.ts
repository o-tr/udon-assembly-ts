import { describe, expect, it } from "vitest";
import {
  ExternTypes,
  PrimitiveTypes,
} from "../../../src/transpiler/frontend/type_symbols";
import { TACOptimizer } from "../../../src/transpiler/ir/optimizer/index.js";
import {
  CopyInstruction,
  PropertySetInstruction,
  TACInstructionKind,
} from "../../../src/transpiler/ir/tac_instruction";
import {
  createConstant,
  createTemporary,
  operandToString,
  
} from "../../../src/transpiler/ir/tac_operand";

describe("copy-on-write temporaries", () => {
  it("copies before mutating shared temporaries", () => {
    const t0 = createTemporary(0, ExternTypes.vector3);
    const t1 = createTemporary(1, ExternTypes.vector3);

    const instructions = [
      new CopyInstruction(t1, t0),
      new PropertySetInstruction(
        t1,
        "x",
        createConstant(1, PrimitiveTypes.single),
      ),
    ];

    const optimizer = new TACOptimizer();
    const optimized = optimizer.optimize(instructions);

    const propertySetIndex = optimized.findIndex(
      (inst) => inst.kind === TACInstructionKind.PropertySet,
    );
    expect(propertySetIndex).toBeGreaterThan(0);

    const copyInst = optimized[propertySetIndex - 1] as CopyInstruction;
    const propInst = optimized[propertySetIndex] as PropertySetInstruction;

    expect(copyInst.kind).toBe(TACInstructionKind.Copy);
    expect(propInst.kind).toBe(TACInstructionKind.PropertySet);
    expect(
      propInst.toString().startsWith(`${operandToString(copyInst.dest)}.`),
    ).toBe(true);
  });
});
