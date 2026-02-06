import { describe, expect, it } from "vitest";
import {
  ExternTypes,
  ObjectType,
  PrimitiveTypes,
} from "../../../src/transpiler/frontend/type_symbols";
import { TACOptimizer } from "../../../src/transpiler/ir/optimizer/index.js";
import { optimizeBlockLayout } from "../../../src/transpiler/ir/optimizer/passes/block_layout";
import { constantFolding } from "../../../src/transpiler/ir/optimizer/passes/constant_folding";
import {
  deadCodeElimination,
  eliminateDeadStoresCFG,
} from "../../../src/transpiler/ir/optimizer/passes/dead_code";
import { eliminateFallthroughJumps } from "../../../src/transpiler/ir/optimizer/passes/fallthrough";
import { globalValueNumbering } from "../../../src/transpiler/ir/optimizer/passes/gvn";
import { optimizeInductionVariables } from "../../../src/transpiler/ir/optimizer/passes/induction";
import { optimizeLoopStructures } from "../../../src/transpiler/ir/optimizer/passes/loop_opts";
import { performPRE } from "../../../src/transpiler/ir/optimizer/passes/pre";
import { sccpAndPrune } from "../../../src/transpiler/ir/optimizer/passes/sccp";
import { optimizeStringConcatenation } from "../../../src/transpiler/ir/optimizer/passes/string_optimization";
import { mergeTails } from "../../../src/transpiler/ir/optimizer/passes/tail_merging";
import { optimizeVectorSwizzle } from "../../../src/transpiler/ir/optimizer/passes/vector_opts";
import {
  ArrayAccessInstruction,
  AssignmentInstruction,
  BinaryOpInstruction,
  CallInstruction,
  CastInstruction,
  ConditionalJumpInstruction,
  CopyInstruction,
  LabelInstruction,
  MethodCallInstruction,
  PropertyGetInstruction,
  PropertySetInstruction,
  ReturnInstruction,
  UnaryOpInstruction,
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

    let optimized = sccpAndPrune(instructions);
    optimized = constantFolding(optimized);
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

    let optimized = sccpAndPrune(instructions);
    optimized = constantFolding(optimized);
    optimized = eliminateDeadStoresCFG(optimized);
    optimized = deadCodeElimination(optimized);
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

    const optimized = globalValueNumbering(instructions);
    const text = stringify(optimized);

    expect(text).toContain("a + b");
    expect(optimized.filter((inst) => inst.kind === "BinaryOp").length).toBe(1);
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

    let optimized = sccpAndPrune(instructions);
    optimized = constantFolding(optimized);
    optimized = eliminateDeadStoresCFG(optimized);
    optimized = deadCodeElimination(optimized);
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

    const optimized = new TACOptimizer().optimize(instructions);
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

    const optimized = new TACOptimizer().optimize(instructions);
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

    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);

    expect(text).not.toContain("goto L1");
    expect(text).not.toContain("goto L2");
  });

  it("reorders block layout to reduce jumps", () => {
    const l0 = createLabel("L0");
    const l1 = createLabel("L1");
    const l2 = createLabel("L2");

    const instructions = [
      new LabelInstruction(l0),
      new UnconditionalJumpInstruction(l2),
      new LabelInstruction(l1),
      new ReturnInstruction(),
      new LabelInstruction(l2),
      new UnconditionalJumpInstruction(l1),
    ];

    const reordered = optimizeBlockLayout(instructions);
    const text = stringify(reordered);

    expect(text.indexOf("L2:")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("L1:")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("L2:")).toBeLessThan(text.indexOf("L1:"));
  });

  it("coalesces string concatenation chains", () => {
    const a = createVariable("a", PrimitiveTypes.string);
    const b = createVariable("b", PrimitiveTypes.string);
    const c = createVariable("c", PrimitiveTypes.string);
    const d = createVariable("d", PrimitiveTypes.string);
    const t0 = createTemporary(0, PrimitiveTypes.string);
    const t1 = createTemporary(1, PrimitiveTypes.string);
    const t2 = createTemporary(2, PrimitiveTypes.string);

    const instructions = [
      new BinaryOpInstruction(t0, a, "+", b),
      new BinaryOpInstruction(t1, t0, "+", c),
      new BinaryOpInstruction(t2, t1, "+", d),
      new ReturnInstruction(t2),
    ];

    const optimized = optimizeStringConcatenation(instructions);

    expect(optimized.filter((inst) => inst.kind === "BinaryOp").length).toBe(0);
    expect(optimized.filter((inst) => inst.kind === "Call").length).toBe(3);
  });

  it("removes fallthrough jumps", () => {
    const l0 = createLabel("L0");
    const instructions = [
      new UnconditionalJumpInstruction(l0),
      new LabelInstruction(l0),
      new ReturnInstruction(),
    ];

    const optimized = eliminateFallthroughJumps(instructions);
    const text = stringify(optimized);

    expect(text).not.toContain("goto L0");
  });

  it("unrolls simple fixed loops", () => {
    const i = createVariable("i", PrimitiveTypes.int32);
    const a = createVariable("a", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.boolean);
    const t1 = createTemporary(1, PrimitiveTypes.int32);
    const lStart = createLabel("L_start");
    const lEnd = createLabel("L_end");

    const instructions = [
      new AssignmentInstruction(i, createConstant(0, PrimitiveTypes.int32)),
      new LabelInstruction(lStart),
      new BinaryOpInstruction(
        t0,
        i,
        "<",
        createConstant(3, PrimitiveTypes.int32),
      ),
      new ConditionalJumpInstruction(t0, lEnd),
      new BinaryOpInstruction(
        t1,
        a,
        "+",
        createConstant(1, PrimitiveTypes.int32),
      ),
      new AssignmentInstruction(a, t1),
      new BinaryOpInstruction(
        i,
        i,
        "+",
        createConstant(1, PrimitiveTypes.int32),
      ),
      new UnconditionalJumpInstruction(lStart),
      new LabelInstruction(lEnd),
      new ReturnInstruction(a),
    ];

    const optimized = optimizeLoopStructures(instructions);
    const text = stringify(optimized);

    expect(text).not.toContain("goto L_start");
    expect(text).not.toContain("ifFalse");
    expect(
      optimized.filter((inst) => inst.kind === "BinaryOp").length,
    ).toBeGreaterThan(1);
  });

  it("merges identical return tails", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const l0 = createLabel("L0");

    const instructions = [
      new ReturnInstruction(a),
      new LabelInstruction(l0),
      new ReturnInstruction(a),
    ];

    const optimized = mergeTails(instructions);
    const text = stringify(optimized);

    expect(text).toContain("tail_merge_");
    expect(text).toContain("goto tail_merge_");
  });

  it("folds scalar Vector3 component updates", () => {
    const v = createVariable("v", ExternTypes.vector3);
    const t0 = createTemporary(0, PrimitiveTypes.single);
    const t1 = createTemporary(1, PrimitiveTypes.single);
    const t2 = createTemporary(2, PrimitiveTypes.single);
    const t3 = createTemporary(3, PrimitiveTypes.single);
    const t4 = createTemporary(4, PrimitiveTypes.single);
    const t5 = createTemporary(5, PrimitiveTypes.single);

    const instructions = [
      new PropertyGetInstruction(t0, v, "x"),
      new BinaryOpInstruction(
        t1,
        t0,
        "+",
        createConstant(1, PrimitiveTypes.single),
      ),
      new PropertySetInstruction(v, "x", t1),
      new PropertyGetInstruction(t2, v, "y"),
      new BinaryOpInstruction(
        t3,
        t2,
        "+",
        createConstant(1, PrimitiveTypes.single),
      ),
      new PropertySetInstruction(v, "y", t3),
      new PropertyGetInstruction(t4, v, "z"),
      new BinaryOpInstruction(
        t5,
        t4,
        "+",
        createConstant(1, PrimitiveTypes.single),
      ),
      new PropertySetInstruction(v, "z", t5),
    ];

    const optimized = optimizeVectorSwizzle(instructions);

    expect(optimized.filter((inst) => inst.kind === "PropertySet").length).toBe(
      0,
    );
    expect(optimized.filter((inst) => inst.kind === "BinaryOp").length).toBe(1);
  });

  it("inserts partial redundancy computations", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const b = createVariable("b", PrimitiveTypes.int32);
    const cond = createVariable("cond", PrimitiveTypes.boolean);
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const lElse = createLabel("L_else");
    const lEnd = createLabel("L_end");

    const instructions = [
      new ConditionalJumpInstruction(cond, lElse),
      new UnconditionalJumpInstruction(lEnd),
      new LabelInstruction(lElse),
      new UnconditionalJumpInstruction(lEnd),
      new LabelInstruction(lEnd),
      new BinaryOpInstruction(t0, a, "+", b),
      new ReturnInstruction(t0),
    ];

    const optimized = performPRE(instructions);
    const text = stringify(optimized);
    const endIndex = text.indexOf("L_end:");
    const exprIndex = text.lastIndexOf("a + b");

    expect(endIndex).toBeGreaterThanOrEqual(0);
    expect(exprIndex).toBeGreaterThanOrEqual(0);
    expect(exprIndex).toBeLessThan(endIndex);
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

    const optimized = new TACOptimizer().optimize(instructions);
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

    const optimized = new TACOptimizer().optimize(instructions);
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

    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain("t0 = 1");
    expect(text).not.toContain("call");
  });

  it("folds additional Mathf extern calls", () => {
    const t0 = createTemporary(0, PrimitiveTypes.single);
    const instructions = [
      new CallInstruction(
        t0,
        "UnityEngineMathf.__Atan2__SystemSingle_SystemSingle__SystemSingle",
        [
          createConstant(1, PrimitiveTypes.single),
          createConstant(1, PrimitiveTypes.single),
        ],
      ),
      new ReturnInstruction(t0),
    ];

    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);

    expect(text).not.toContain("UnityEngineMathf.__Atan2");
    expect(text).toContain("t0 =");
  });

  it("folds String.Concat with constants", () => {
    const t0 = createTemporary(0, PrimitiveTypes.string);
    const instructions = [
      new CallInstruction(
        t0,
        "SystemString.__Concat__SystemString_SystemString__SystemString",
        [
          createConstant("Hello ", PrimitiveTypes.string),
          createConstant("World", PrimitiveTypes.string),
        ],
      ),
      new ReturnInstruction(t0),
    ];

    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain('t0 = "Hello World"');
    expect(text).not.toContain("call");
  });

  it("folds Vector3.Dot with constant vectors", () => {
    const t0 = createTemporary(0, PrimitiveTypes.single);
    const v1 = createConstant({ x: 1, y: 0, z: 0 }, ExternTypes.vector3);
    const v2 = createConstant({ x: 1, y: 2, z: 3 }, ExternTypes.vector3);
    const instructions = [
      new CallInstruction(
        t0,
        "UnityEngineVector3.__Dot__UnityEngineVector3_UnityEngineVector3__SystemSingle",
        [v1, v2],
      ),
      new ReturnInstruction(t0),
    ];

    const optimized = new TACOptimizer().optimize(instructions);
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

  it("simplifies division and modulo by power of two", () => {
    const x = createVariable("x", PrimitiveTypes.uint32);
    const t0 = createTemporary(0, PrimitiveTypes.uint32);
    const t1 = createTemporary(1, PrimitiveTypes.uint32);
    const t2 = createTemporary(2, PrimitiveTypes.uint32);
    const instructions = [
      new BinaryOpInstruction(
        t0,
        x,
        "/",
        createConstant(8, PrimitiveTypes.uint32),
      ),
      new BinaryOpInstruction(
        t1,
        x,
        "%",
        createConstant(8, PrimitiveTypes.uint32),
      ),
      new BinaryOpInstruction(t2, t0, "+", t1),
      new ReturnInstruction(t2),
    ];

    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);

    expect(text).toContain("x >> 3");
    expect(text).toContain("x & 7");
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

    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);

    const hoistedIndex = text.indexOf("t0 = a + b");
    const loopIndex = text.indexOf("L_start");
    expect(hoistedIndex).toBeGreaterThan(-1);
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

    const optimized = optimizeInductionVariables(instructions);
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

  it("eliminates redundant idempotent extern calls", () => {
    const t0 = createTemporary(0, ExternTypes.vector3);
    const t1 = createTemporary(1, ExternTypes.vector3);
    const instructions = [
      new CallInstruction(
        t0,
        "UnityEngineVector3.__get_zero__UnityEngineVector3",
        [],
      ),
      new CallInstruction(
        t1,
        "UnityEngineVector3.__get_zero__UnityEngineVector3",
        [],
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

  it("fuses negated comparison into inverted comparison", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const b = createVariable("b", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.boolean);
    const t1 = createTemporary(1, PrimitiveTypes.boolean);
    const instructions = [
      new BinaryOpInstruction(t0, a, "<", b),
      new UnaryOpInstruction(t1, "!", t0),
      new ReturnInstruction(t1),
    ];
    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);
    expect(text).toContain("a >= b");
    expect(optimized.filter((inst) => inst.kind === "UnaryOp").length).toBe(0);
  });

  it("does not fuse negated comparison when comparison result is reused", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const b = createVariable("b", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.boolean);
    const t1 = createTemporary(1, PrimitiveTypes.boolean);
    const instructions = [
      new BinaryOpInstruction(t0, a, "<", b),
      new UnaryOpInstruction(t1, "!", t0),
      new ReturnInstruction(t0),
    ];
    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);
    expect(text).toContain("a < b");
    expect(text).not.toContain("a >= b");
  });

  it("forwards stored value to subsequent PropertyGet", () => {
    const obj = createVariable("obj", ExternTypes.transform);
    const val = createVariable("val", ExternTypes.vector3);
    const t0 = createTemporary(0, ExternTypes.vector3);
    const instructions = [
      new PropertySetInstruction(obj, "position", val),
      new PropertyGetInstruction(t0, obj, "position"),
      new ReturnInstruction(t0),
    ];
    const optimized = new TACOptimizer().optimize(instructions);
    expect(optimized.filter((inst) => inst.kind === "PropertyGet").length).toBe(
      0,
    );
    const text = stringify(optimized);
    expect(text).toContain("t0 = val");
  });

  it("does not forward PropertyGet across MethodCall", () => {
    const obj = createVariable("obj", ExternTypes.transform);
    const val = createVariable("val", ExternTypes.vector3);
    const t0 = createTemporary(0, ExternTypes.vector3);
    const instructions = [
      new PropertySetInstruction(obj, "position", val),
      new MethodCallInstruction(undefined, obj, "Rotate", []),
      new PropertyGetInstruction(t0, obj, "position"),
      new ReturnInstruction(t0),
    ];
    const optimized = new TACOptimizer().optimize(instructions);
    expect(optimized.filter((inst) => inst.kind === "PropertyGet").length).toBe(
      1,
    );
  });

  it("eliminates double negation", () => {
    const a = createVariable("a", PrimitiveTypes.boolean);
    const t0 = createTemporary(0, PrimitiveTypes.boolean);
    const t1 = createTemporary(1, PrimitiveTypes.boolean);
    const instructions = [
      new UnaryOpInstruction(t0, "!", a),
      new UnaryOpInstruction(t1, "!", t0),
      new ReturnInstruction(t1),
    ];
    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);
    expect(text).not.toContain("!");
    expect(optimized.filter((inst) => inst.kind === "UnaryOp").length).toBe(0);
  });

  it("does not eliminate double negation when inner result is reused", () => {
    const a = createVariable("a", PrimitiveTypes.boolean);
    const t0 = createTemporary(0, PrimitiveTypes.boolean);
    const t1 = createTemporary(1, PrimitiveTypes.boolean);
    const instructions = [
      new UnaryOpInstruction(t0, "!", a),
      new UnaryOpInstruction(t1, "!", t0),
      new ReturnInstruction(t0),
    ];
    const optimized = new TACOptimizer().optimize(instructions);
    expect(optimized.filter((inst) => inst.kind === "UnaryOp").length).toBe(1);
  });

  it("eliminates redundant ArrayAccess", () => {
    const arr = createVariable("arr", ObjectType);
    const idx = createVariable("idx", PrimitiveTypes.int32);
    const t0 = createTemporary(0, ObjectType);
    const t1 = createTemporary(1, ObjectType);
    const instructions = [
      new ArrayAccessInstruction(t0, arr, idx),
      new ArrayAccessInstruction(t1, arr, idx),
      new ReturnInstruction(t1),
    ];
    const optimized = new TACOptimizer().optimize(instructions);
    expect(optimized.filter((inst) => inst.kind === "ArrayAccess").length).toBe(
      1,
    );
  });

  it("simplifies x && x to x", () => {
    const a = createVariable("a", PrimitiveTypes.boolean);
    const t0 = createTemporary(0, PrimitiveTypes.boolean);
    const instructions = [
      new BinaryOpInstruction(t0, a, "&&", a),
      new ReturnInstruction(t0),
    ];
    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);
    expect(text).toContain("t0 = a");
    expect(optimized.filter((inst) => inst.kind === "BinaryOp").length).toBe(0);
  });

  it("simplifies x == x to true for integers", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.boolean);
    const instructions = [
      new BinaryOpInstruction(t0, a, "==", a),
      new ReturnInstruction(t0),
    ];
    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);
    expect(text).toContain("t0 = true");
  });

  it("folds int-to-float-to-double cast chain", () => {
    const x = createVariable("x", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.single);
    const t1 = createTemporary(1, PrimitiveTypes.double);
    const instructions = [
      new CastInstruction(t0, x),
      new CastInstruction(t1, t0),
      new ReturnInstruction(t1),
    ];
    const optimized = new TACOptimizer().optimize(instructions);
    expect(
      optimized.filter((inst) => inst.kind === "Cast").length,
    ).toBeLessThanOrEqual(1);
  });

  it("does not fold float-to-int-to-double cast chain", () => {
    const x = createVariable("x", PrimitiveTypes.single);
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const t1 = createTemporary(1, PrimitiveTypes.double);
    const instructions = [
      new CastInstruction(t0, x),
      new CastInstruction(t1, t0),
      new ReturnInstruction(t1),
    ];
    const optimized = new TACOptimizer().optimize(instructions);
    expect(optimized.filter((inst) => inst.kind === "Cast").length).toBe(2);
  });

  it("removes labels with no incoming jumps", () => {
    const l0 = createLabel("L_used");
    const l1 = createLabel("L_unused");
    const instructions = [
      new UnconditionalJumpInstruction(l0),
      new LabelInstruction(l1),
      new LabelInstruction(l0),
      new ReturnInstruction(),
    ];
    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);
    expect(text).not.toContain("L_unused");
  });
});
