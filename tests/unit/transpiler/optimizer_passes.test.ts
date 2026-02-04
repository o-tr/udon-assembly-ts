import { describe, expect, it } from "vitest";
import { PrimitiveTypes } from "../../../src/transpiler/frontend/type_symbols";
import { TACOptimizer } from "../../../src/transpiler/ir/optimizer";
import {
  AssignmentInstruction,
  BinaryOpInstruction,
  CopyInstruction,
} from "../../../src/transpiler/ir/tac_instruction";
import {
  createConstant,
  createTemporary,
  createVariable,
} from "../../../src/transpiler/ir/tac_operand";

const stringify = (insts: { toString(): string }[]) =>
  insts.map((inst) => inst.toString()).join("\n");

describe("optimizer passes", () => {
  it("propagates copies and constants", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const b = createVariable("b", PrimitiveTypes.int32);
    const c = createVariable("c", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.int32);

    const instructions = [
      new AssignmentInstruction(a, createConstant(1, PrimitiveTypes.int32)),
      new CopyInstruction(b, a),
      new CopyInstruction(c, b),
      new BinaryOpInstruction(t0, c, "+", a),
    ];

    const optimizer = new TACOptimizer();
    const optimized = optimizer.optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain("t0 = 1 + 1");
  });

  it("eliminates dead assignments", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const b = createVariable("b", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.int32);

    const instructions = [
      new AssignmentInstruction(a, createConstant(1, PrimitiveTypes.int32)),
      new AssignmentInstruction(b, createConstant(2, PrimitiveTypes.int32)),
      new BinaryOpInstruction(t0, a, "+", a),
    ];

    const optimizer = new TACOptimizer();
    const optimized = optimizer.optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain("t0 = 1 + 1");
    expect(text).not.toContain("b = 2");
  });

  it("removes common subexpressions", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const b = createVariable("b", PrimitiveTypes.int32);
    const t1 = createTemporary(0, PrimitiveTypes.int32);
    const t2 = createTemporary(1, PrimitiveTypes.int32);

    const instructions = [
      new BinaryOpInstruction(t1, a, "+", b),
      new BinaryOpInstruction(t2, a, "+", b),
    ];

    const optimizer = new TACOptimizer();
    const optimized = optimizer.optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain("a + b");
    expect(optimized.filter((inst) => inst.kind === "BinaryOp").length).toBe(1);
    expect(optimized.filter((inst) => inst.kind === "Copy").length).toBe(0);
  });

  it("folds string concatenation", () => {
    const t0 = createTemporary(0, PrimitiveTypes.string);
    const instructions = [
      new BinaryOpInstruction(
        t0,
        createConstant("Hello ", PrimitiveTypes.string),
        "+",
        createConstant("World", PrimitiveTypes.string),
      ),
    ];

    const optimizer = new TACOptimizer();
    const optimized = optimizer.optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain('t0 = "Hello World"');
    expect(optimized.filter((inst) => inst.kind === "BinaryOp").length).toBe(0);
  });

  it("folds boolean operators", () => {
    const t0 = createTemporary(0, PrimitiveTypes.boolean);
    const instructions = [
      new BinaryOpInstruction(
        t0,
        createConstant(true, PrimitiveTypes.boolean),
        "&&",
        createConstant(false, PrimitiveTypes.boolean),
      ),
    ];

    const optimizer = new TACOptimizer();
    const optimized = optimizer.optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain("t0 = false");
    expect(optimized.filter((inst) => inst.kind === "BinaryOp").length).toBe(0);
  });
});
