import { describe, expect, it } from "vitest";
import {
  ExternTypes,
  ObjectType,
  PrimitiveTypes,
} from "../../../src/transpiler/frontend/type_symbols";
import { TACOptimizer } from "../../../src/transpiler/ir/optimizer/index.js";
import {
  AssignmentInstruction,
  BinaryOpInstruction,
  CallInstruction,
  ConditionalJumpInstruction,
  CopyInstruction,
  LabelInstruction,
  PropertyGetInstruction,
  PropertySetInstruction,
  ReturnInstruction,
  UnconditionalJumpInstruction,
} from "../../../src/transpiler/ir/tac_instruction";
import {
  createConstant,
  createLabel,
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
      new ReturnInstruction(t0),
    ];

    const optimizer = new TACOptimizer();
    const optimized = optimizer.optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain("t0 = 2");
  });

  it("eliminates dead assignments", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const b = createVariable("b", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.int32);

    const instructions = [
      new AssignmentInstruction(a, createConstant(1, PrimitiveTypes.int32)),
      new AssignmentInstruction(b, createConstant(2, PrimitiveTypes.int32)),
      new BinaryOpInstruction(t0, a, "+", a),
      new ReturnInstruction(t0),
    ];

    const optimizer = new TACOptimizer();
    const optimized = optimizer.optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain("t0 = 2");
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
      new ReturnInstruction(t2),
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
      new ReturnInstruction(t0),
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
      new ReturnInstruction(t0),
    ];

    const optimizer = new TACOptimizer();
    const optimized = optimizer.optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain("t0 = false");
    expect(optimized.filter((inst) => inst.kind === "BinaryOp").length).toBe(0);
  });

  it("eliminates no-op copies", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const instructions = [
      new AssignmentInstruction(a, a),
      new ReturnInstruction(a),
    ];

    const optimizer = new TACOptimizer();
    const optimized = optimizer.optimize(instructions);
    const text = stringify(optimized);

    expect(text).not.toContain("a = a");
    expect(
      optimized.filter(
        (inst) => inst.kind === "Assignment" || inst.kind === "Copy",
      ).length,
    ).toBe(0);
  });

  it("removes unused temporary computations", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const instructions = [
      new BinaryOpInstruction(t0, a, "+", a),
      new ReturnInstruction(a),
    ];

    const optimizer = new TACOptimizer();
    const optimized = optimizer.optimize(instructions);

    expect(optimized.filter((inst) => inst.kind === "BinaryOp").length).toBe(0);
  });

  it("threads and removes redundant jumps", () => {
    const l0 = createLabel("L0");
    const l1 = createLabel("L1");
    const l2 = createLabel("L2");
    const lX = createLabel("LX");

    const instructions = [
      new LabelInstruction(l0),
      new UnconditionalJumpInstruction(l1),
      new LabelInstruction(lX),
      new ReturnInstruction(),
      new LabelInstruction(l1),
      new UnconditionalJumpInstruction(l2),
      new LabelInstruction(l2),
      new ReturnInstruction(),
    ];

    const optimizer = new TACOptimizer();
    const optimized = optimizer.optimize(instructions);
    const text = stringify(optimized);

    expect(text).not.toContain("goto L1");
    expect(text).not.toContain("goto L2");
    expect(text).toContain("L2:");
  });

  it("prunes unreachable blocks on constant branches", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const lThen = createLabel("L_then");
    const lElse = createLabel("L_else");
    const lEnd = createLabel("L_end");

    const instructions = [
      new ConditionalJumpInstruction(
        createConstant(false, PrimitiveTypes.boolean),
        lThen,
      ),
      new LabelInstruction(lElse),
      new AssignmentInstruction(a, createConstant(2, PrimitiveTypes.int32)),
      new UnconditionalJumpInstruction(lEnd),
      new LabelInstruction(lThen),
      new AssignmentInstruction(a, createConstant(1, PrimitiveTypes.int32)),
      new LabelInstruction(lEnd),
      new ReturnInstruction(a),
    ];

    const optimizer = new TACOptimizer();
    const optimized = optimizer.optimize(instructions);
    const text = stringify(optimized);

    expect(text).not.toContain("L_else");
    expect(text).not.toContain("a = 2");
    expect(text).toContain("return 1");
  });

  it("simplifies boolean identities", () => {
    const a = createVariable("a", PrimitiveTypes.boolean);
    const t0 = createTemporary(0, PrimitiveTypes.boolean);
    const instructions = [
      new BinaryOpInstruction(
        t0,
        a,
        "&&",
        createConstant(true, PrimitiveTypes.boolean),
      ),
      new ReturnInstruction(t0),
    ];

    const optimizer = new TACOptimizer();
    const optimized = optimizer.optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain("t0 = a");
    expect(optimized.filter((inst) => inst.kind === "BinaryOp").length).toBe(0);
  });

  it("folds pure Mathf extern calls", () => {
    const t0 = createTemporary(0, PrimitiveTypes.single);
    const instructions = [
      new CallInstruction(
        t0,
        "UnityEngineMathf.__Abs__SystemSingle__SystemSingle",
        [createConstant(-1, PrimitiveTypes.single)],
      ),
      new ReturnInstruction(t0),
    ];

    const optimizer = new TACOptimizer();
    const optimized = optimizer.optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain("t0 = 1");
    expect(text).not.toContain("call");
  });

  it("reuses expressions across basic blocks", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const b = createVariable("b", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const t1 = createTemporary(1, PrimitiveTypes.int32);
    const l1 = createLabel("L1");

    const instructions = [
      new BinaryOpInstruction(t0, a, "+", b),
      new UnconditionalJumpInstruction(l1),
      new LabelInstruction(l1),
      new BinaryOpInstruction(t1, a, "+", b),
      new ReturnInstruction(t1),
    ];

    const optimizer = new TACOptimizer();
    const optimized = optimizer.optimize(instructions);

    expect(optimized.filter((inst) => inst.kind === "BinaryOp").length).toBe(1);
  });

  it("hoists loop-invariant computations", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const b = createVariable("b", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const cond = createVariable("cond", PrimitiveTypes.boolean);
    const lPre = createLabel("L_pre");
    const lStart = createLabel("L_start");
    const lEnd = createLabel("L_end");

    const instructions = [
      new LabelInstruction(lPre),
      new UnconditionalJumpInstruction(lStart),
      new LabelInstruction(lStart),
      new BinaryOpInstruction(t0, a, "+", b),
      new BinaryOpInstruction(
        cond,
        t0,
        "==",
        createConstant(0, PrimitiveTypes.int32),
      ),
      new ConditionalJumpInstruction(cond, lEnd),
      new UnconditionalJumpInstruction(lStart),
      new LabelInstruction(lEnd),
      new ReturnInstruction(a),
    ];

    const optimizer = new TACOptimizer();
    const optimized = optimizer.optimize(instructions);
    const text = stringify(optimized);

    const preIndex = text.indexOf("L_pre");
    const hoistedIndex = text.indexOf("t0 = a + b");
    const loopIndex = text.indexOf("L_start");
    expect(hoistedIndex).toBeGreaterThan(-1);
    expect(preIndex).toBeGreaterThan(-1);
    expect(loopIndex).toBeGreaterThan(-1);
    expect(hoistedIndex).toBeLessThan(loopIndex);
  });

  it("optimizes simple induction variables", () => {
    const i = createVariable("i", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const cond = createTemporary(1, PrimitiveTypes.boolean);
    const lPre = createLabel("L_pre");
    const lStart = createLabel("L_start");

    const instructions = [
      new LabelInstruction(lPre),
      new UnconditionalJumpInstruction(lStart),
      new LabelInstruction(lStart),
      new BinaryOpInstruction(
        i,
        i,
        "+",
        createConstant(1, PrimitiveTypes.int32),
      ),
      new BinaryOpInstruction(
        t0,
        i,
        "*",
        createConstant(2, PrimitiveTypes.int32),
      ),
      new BinaryOpInstruction(
        cond,
        t0,
        "<",
        createConstant(10, PrimitiveTypes.int32),
      ),
      new ConditionalJumpInstruction(cond, lStart),
      new ReturnInstruction(i),
    ];

    const optimizer = new TACOptimizer();
    const optimized = optimizer.optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain("t0 = t0 + 2");
    expect(
      optimized.filter((inst) => inst.kind === "BinaryOp").length,
    ).toBeGreaterThan(0);
    expect(text).toContain("t0 = i * 2");
  });

  it("iterative passes fold multi-step constants", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const b = createVariable("b", PrimitiveTypes.int32);
    const c = createVariable("c", PrimitiveTypes.int32);

    const instructions = [
      new AssignmentInstruction(a, createConstant(3, PrimitiveTypes.int32)),
      new BinaryOpInstruction(
        b,
        a,
        "+",
        createConstant(4, PrimitiveTypes.int32),
      ),
      new BinaryOpInstruction(
        c,
        b,
        "*",
        createConstant(2, PrimitiveTypes.int32),
      ),
      new ReturnInstruction(c),
    ];

    const optimizer = new TACOptimizer();
    const optimized = optimizer.optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain("return 14");
    expect(optimized.filter((inst) => inst.kind === "BinaryOp").length).toBe(0);
  });

  it("simplifies x - x to zero for integers", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const instructions = [
      new BinaryOpInstruction(t0, a, "-", a),
      new ReturnInstruction(t0),
    ];

    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain("t0 = 0");
    expect(optimized.filter((inst) => inst.kind === "BinaryOp").length).toBe(0);
  });

  it("simplifies x & 0 to zero", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const instructions = [
      new BinaryOpInstruction(
        t0,
        a,
        "&",
        createConstant(0, PrimitiveTypes.int32),
      ),
      new ReturnInstruction(t0),
    ];

    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain("t0 = 0");
    expect(optimized.filter((inst) => inst.kind === "BinaryOp").length).toBe(0);
  });

  it("simplifies x | 0 to x", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const instructions = [
      new BinaryOpInstruction(
        t0,
        a,
        "|",
        createConstant(0, PrimitiveTypes.int32),
      ),
      new ReturnInstruction(t0),
    ];

    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain("t0 = a");
    expect(optimized.filter((inst) => inst.kind === "BinaryOp").length).toBe(0);
  });

  it("simplifies x ^ 0 to x", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const instructions = [
      new BinaryOpInstruction(
        t0,
        a,
        "^",
        createConstant(0, PrimitiveTypes.int32),
      ),
      new ReturnInstruction(t0),
    ];

    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain("t0 = a");
    expect(optimized.filter((inst) => inst.kind === "BinaryOp").length).toBe(0);
  });

  it("simplifies x & x to x", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const instructions = [
      new BinaryOpInstruction(t0, a, "&", a),
      new ReturnInstruction(t0),
    ];

    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain("t0 = a");
    expect(optimized.filter((inst) => inst.kind === "BinaryOp").length).toBe(0);
  });

  it("simplifies x | x to x", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const instructions = [
      new BinaryOpInstruction(t0, a, "|", a),
      new ReturnInstruction(t0),
    ];

    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain("t0 = a");
    expect(optimized.filter((inst) => inst.kind === "BinaryOp").length).toBe(0);
  });

  it("simplifies x ^ x to zero for integers", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const instructions = [
      new BinaryOpInstruction(t0, a, "^", a),
      new ReturnInstruction(t0),
    ];

    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain("t0 = 0");
    expect(optimized.filter((inst) => inst.kind === "BinaryOp").length).toBe(0);
  });

  it("simplifies x << 0 to x", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const instructions = [
      new BinaryOpInstruction(
        t0,
        a,
        "<<",
        createConstant(0, PrimitiveTypes.int32),
      ),
      new ReturnInstruction(t0),
    ];

    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain("t0 = a");
    expect(optimized.filter((inst) => inst.kind === "BinaryOp").length).toBe(0);
  });

  it("simplifies x >> 0 to x", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const instructions = [
      new BinaryOpInstruction(
        t0,
        a,
        ">>",
        createConstant(0, PrimitiveTypes.int32),
      ),
      new ReturnInstruction(t0),
    ];

    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain("t0 = a");
    expect(optimized.filter((inst) => inst.kind === "BinaryOp").length).toBe(0);
  });

  it("reassociates addition of constants", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const t1 = createTemporary(1, PrimitiveTypes.int32);
    const instructions = [
      new BinaryOpInstruction(
        t0,
        a,
        "+",
        createConstant(3, PrimitiveTypes.int32),
      ),
      new BinaryOpInstruction(
        t1,
        t0,
        "+",
        createConstant(4, PrimitiveTypes.int32),
      ),
      new ReturnInstruction(t1),
    ];

    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain("a + 7");
  });

  it("reassociates multiplication of constants", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const t1 = createTemporary(1, PrimitiveTypes.int32);
    const instructions = [
      new BinaryOpInstruction(
        t0,
        a,
        "*",
        createConstant(3, PrimitiveTypes.int32),
      ),
      new BinaryOpInstruction(
        t1,
        t0,
        "*",
        createConstant(5, PrimitiveTypes.int32),
      ),
      new ReturnInstruction(t1),
    ];

    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain("a * 15");
  });

  it("eliminates redundant PropertyGet", () => {
    const obj = createVariable("obj", ExternTypes.transform);
    const t0 = createTemporary(0, ExternTypes.vector3);
    const t1 = createTemporary(1, ExternTypes.vector3);
    const instructions = [
      new PropertyGetInstruction(t0, obj, "position"),
      new PropertyGetInstruction(t1, obj, "position"),
      new ReturnInstruction(t1),
    ];

    const optimized = new TACOptimizer().optimize(instructions);

    expect(optimized.filter((inst) => inst.kind === "PropertyGet").length).toBe(
      1,
    );
  });

  it("does not CSE PropertyGet across PropertySet on same object", () => {
    const obj = createVariable("obj", ExternTypes.transform);
    const t0 = createTemporary(0, ExternTypes.vector3);
    const t1 = createTemporary(1, ExternTypes.vector3);
    const val = createConstant(1.0, PrimitiveTypes.single);
    const instructions = [
      new PropertyGetInstruction(t0, obj, "x"),
      new PropertySetInstruction(obj, "y", val),
      new PropertyGetInstruction(t1, obj, "x"),
      new ReturnInstruction(t1),
    ];

    const optimized = new TACOptimizer().optimize(instructions);

    expect(optimized.filter((inst) => inst.kind === "PropertyGet").length).toBe(
      2,
    );
  });

  it("eliminates redundant pure extern calls", () => {
    const x = createVariable("x", PrimitiveTypes.single);
    const t0 = createTemporary(0, PrimitiveTypes.single);
    const t1 = createTemporary(1, PrimitiveTypes.single);
    const instructions = [
      new CallInstruction(
        t0,
        "UnityEngineMathf.__Sqrt__SystemSingle__SystemSingle",
        [x],
      ),
      new CallInstruction(
        t1,
        "UnityEngineMathf.__Sqrt__SystemSingle__SystemSingle",
        [x],
      ),
      new ReturnInstruction(t1),
    ];

    const optimized = new TACOptimizer().optimize(instructions);

    expect(optimized.filter((inst) => inst.kind === "Call").length).toBe(1);
  });

  it("does not CSE non-pure extern calls", () => {
    const obj = createVariable("obj", ObjectType);
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const t1 = createTemporary(1, PrimitiveTypes.int32);
    const instructions = [
      new CallInstruction(t0, "SomeNonPureExtern", [obj]),
      new CallInstruction(t1, "SomeNonPureExtern", [obj]),
      new ReturnInstruction(t1),
    ];

    const optimized = new TACOptimizer().optimize(instructions);

    expect(optimized.filter((inst) => inst.kind === "Call").length).toBe(2);
  });
});
