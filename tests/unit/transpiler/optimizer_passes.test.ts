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
import { performLICM } from "../../../src/transpiler/ir/optimizer/passes/licm";
import { optimizeLoopStructures } from "../../../src/transpiler/ir/optimizer/passes/loop_opts";
import { performPRE } from "../../../src/transpiler/ir/optimizer/passes/pre";
import { sccpAndPrune } from "../../../src/transpiler/ir/optimizer/passes/sccp";
import { optimizeStringConcatenation } from "../../../src/transpiler/ir/optimizer/passes/string_optimization";
import { sinkCode } from "../../../src/transpiler/ir/optimizer/passes/code_sinking";
import { simplifyDiamondPatterns } from "../../../src/transpiler/ir/optimizer/passes/diamond_simplification";
import { unswitchLoops } from "../../../src/transpiler/ir/optimizer/passes/loop_unswitching";
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
  type ConstantOperand,
  createConstant,
  createLabel,
  createTemporary,
  createVariable,
  TACOperandKind,
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

  it("keeps conditional jump blocks during layout", () => {
    const cond = createVariable("cond", PrimitiveTypes.boolean);
    const l0 = createLabel("L0");
    const l1 = createLabel("L1");
    const l2 = createLabel("L2");

    const instructions = [
      new LabelInstruction(l0),
      new ConditionalJumpInstruction(cond, l2),
      new LabelInstruction(l1),
      new ReturnInstruction(),
      new LabelInstruction(l2),
      new ReturnInstruction(),
    ];

    const reordered = optimizeBlockLayout(instructions);
    const text = stringify(reordered);

    expect(text).toContain("L0:");
    expect(text).toContain("L1:");
    expect(text).toContain("L2:");
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

  it("coalesces two-op string concatenation chains", () => {
    const a = createVariable("a", PrimitiveTypes.string);
    const b = createVariable("b", PrimitiveTypes.string);
    const c = createVariable("c", PrimitiveTypes.string);
    const t0 = createTemporary(0, PrimitiveTypes.string);
    const t1 = createTemporary(1, PrimitiveTypes.string);

    const instructions = [
      new BinaryOpInstruction(t0, a, "+", b),
      new BinaryOpInstruction(t1, t0, "+", c),
      new ReturnInstruction(t1),
    ];

    const optimized = optimizeStringConcatenation(instructions);

    expect(optimized.filter((inst) => inst.kind === "BinaryOp").length).toBe(0);
    expect(optimized.filter((inst) => inst.kind === "Call").length).toBe(2);
  });

  it("does not coalesce single string concatenation", () => {
    const a = createVariable("a", PrimitiveTypes.string);
    const b = createVariable("b", PrimitiveTypes.string);
    const t0 = createTemporary(0, PrimitiveTypes.string);

    const instructions = [new BinaryOpInstruction(t0, a, "+", b)];

    const optimized = optimizeStringConcatenation(instructions);

    expect(optimized.filter((inst) => inst.kind === "BinaryOp").length).toBe(1);
    expect(optimized.filter((inst) => inst.kind === "Call").length).toBe(0);
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

  it("removes fallthrough jumps across consecutive labels", () => {
    const l0 = createLabel("L0");
    const l1 = createLabel("L1");
    const instructions = [
      new UnconditionalJumpInstruction(l0),
      new LabelInstruction(l1),
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

  it("unrolls loops and keeps increments", () => {
    const i = createVariable("i", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.boolean);
    const lStart = createLabel("L_start");
    const lEnd = createLabel("L_end");

    const instructions = [
      new AssignmentInstruction(i, createConstant(0, PrimitiveTypes.int32)),
      new LabelInstruction(lStart),
      new BinaryOpInstruction(
        t0,
        i,
        "<",
        createConstant(2, PrimitiveTypes.int32),
      ),
      new ConditionalJumpInstruction(t0, lEnd),
      new BinaryOpInstruction(
        i,
        i,
        "+",
        createConstant(1, PrimitiveTypes.int32),
      ),
      new UnconditionalJumpInstruction(lStart),
      new LabelInstruction(lEnd),
      new ReturnInstruction(i),
    ];

    const optimized = optimizeLoopStructures(instructions);
    const text = stringify(optimized);
    const incrementCount = text.split("i = i + 1").length - 1;

    expect(text).not.toContain("goto L_start");
    expect(text).not.toContain("ifFalse");
    expect(incrementCount).toBeGreaterThanOrEqual(2);
  });

  it("does not unroll loops with condition gaps", () => {
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
      new BinaryOpInstruction(
        t1,
        a,
        "+",
        createConstant(1, PrimitiveTypes.int32),
      ),
      new ConditionalJumpInstruction(t0, lEnd),
      new BinaryOpInstruction(
        i,
        i,
        "+",
        createConstant(1, PrimitiveTypes.int32),
      ),
      new UnconditionalJumpInstruction(lStart),
      new LabelInstruction(lEnd),
      new ReturnInstruction(i),
    ];

    const optimized = optimizeLoopStructures(instructions);
    const text = stringify(optimized);

    expect(text).toContain("goto L_start");
  });

  it("unrolls <= loops with fresh temporaries", () => {
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
        "<=",
        createConstant(1, PrimitiveTypes.int32),
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
    const tempMatches = text.match(/t\d+/g) ?? [];
    const uniqueTemps = new Set(tempMatches);

    expect(text).not.toContain("goto L_start");
    expect(text).not.toContain("ifFalse");
    expect(uniqueTemps.size).toBeGreaterThanOrEqual(2);
  });

  it("does not unroll zero-trip loops", () => {
    const i = createVariable("i", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.boolean);
    const lStart = createLabel("L_start");
    const lEnd = createLabel("L_end");

    const instructions = [
      new AssignmentInstruction(i, createConstant(3, PrimitiveTypes.int32)),
      new LabelInstruction(lStart),
      new BinaryOpInstruction(
        t0,
        i,
        "<",
        createConstant(3, PrimitiveTypes.int32),
      ),
      new ConditionalJumpInstruction(t0, lEnd),
      new BinaryOpInstruction(
        i,
        i,
        "+",
        createConstant(1, PrimitiveTypes.int32),
      ),
      new UnconditionalJumpInstruction(lStart),
      new LabelInstruction(lEnd),
      new ReturnInstruction(i),
    ];

    const optimized = optimizeLoopStructures(instructions);
    const text = stringify(optimized);

    expect(text).toContain("goto L_start");
  });

  it("does not unroll negative-step loops", () => {
    const i = createVariable("i", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.boolean);
    const lStart = createLabel("L_start");
    const lEnd = createLabel("L_end");

    const instructions = [
      new AssignmentInstruction(i, createConstant(3, PrimitiveTypes.int32)),
      new LabelInstruction(lStart),
      new BinaryOpInstruction(
        t0,
        i,
        ">",
        createConstant(0, PrimitiveTypes.int32),
      ),
      new ConditionalJumpInstruction(t0, lEnd),
      new BinaryOpInstruction(
        i,
        i,
        "-",
        createConstant(1, PrimitiveTypes.int32),
      ),
      new UnconditionalJumpInstruction(lStart),
      new LabelInstruction(lEnd),
      new ReturnInstruction(i),
    ];

    const optimized = optimizeLoopStructures(instructions);
    const text = stringify(optimized);

    expect(text).toContain("goto L_start");
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

  it("merges three identical return tails", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const l0 = createLabel("L0");
    const l1 = createLabel("L1");

    const instructions = [
      new ReturnInstruction(a),
      new LabelInstruction(l0),
      new ReturnInstruction(a),
      new LabelInstruction(l1),
      new ReturnInstruction(a),
    ];

    const optimized = mergeTails(instructions);
    const text = stringify(optimized);
    const gotoCount = text.split("goto tail_merge_").length - 1;

    expect(text).toContain("tail_merge_");
    expect(gotoCount).toBeGreaterThanOrEqual(2);
  });

  it("does not merge tails with side-effecting calls", () => {
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const l0 = createLabel("L0");

    const instructions = [
      new CallInstruction(t0, "Foo", []),
      new ReturnInstruction(t0),
      new LabelInstruction(l0),
      new CallInstruction(t0, "Foo", []),
      new ReturnInstruction(t0),
    ];

    const optimized = mergeTails(instructions);
    const text = stringify(optimized);

    expect(text).not.toContain("tail_merge_");
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
    const endLabelIndex = optimized.findIndex(
      (inst) => inst.kind === "Label" && inst.toString().startsWith("L_end:"),
    );
    // there should be no 'a + b' BinaryOp after the end label
    const hasBinAfterEnd = optimized
      .slice(endLabelIndex)
      .some(
        (inst) => inst.kind === "BinaryOp" && inst.toString().includes("a + b"),
      );
    // there should be BinaryOp(s) inserted before the end label (in preds)
    const hasBinBeforeEnd = optimized
      .slice(0, endLabelIndex)
      .some(
        (inst) => inst.kind === "BinaryOp" && inst.toString().includes("a + b"),
      );

    expect(endLabelIndex).toBeGreaterThanOrEqual(0);
    expect(hasBinBeforeEnd).toBe(true);
    expect(hasBinAfterEnd).toBe(false);
  });

  it("hoists when operands are temps defined in preds", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const b = createVariable("b", PrimitiveTypes.int32);
    const c = createVariable("c", PrimitiveTypes.int32);
    const cond = createVariable("cond", PrimitiveTypes.boolean);
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const t1 = createTemporary(1, PrimitiveTypes.int32);
    const lElse = createLabel("L_else");
    const lEnd = createLabel("L_end");

    const instructions = [
      new ConditionalJumpInstruction(cond, lElse),
      new BinaryOpInstruction(t0, a, "+", b),
      new UnconditionalJumpInstruction(lEnd),
      new LabelInstruction(lElse),
      new BinaryOpInstruction(t0, a, "+", b),
      new UnconditionalJumpInstruction(lEnd),
      new LabelInstruction(lEnd),
      new BinaryOpInstruction(t1, t0, "+", c),
      new ReturnInstruction(t1),
    ];

    const optimized = performPRE(instructions);
    const endLabelIndex = optimized.findIndex(
      (inst) => inst.kind === "Label" && inst.toString().startsWith("L_end:"),
    );
    const hasBinAfterEnd = optimized
      .slice(endLabelIndex)
      .some(
        (inst) =>
          inst.kind === "BinaryOp" && inst.toString().includes("t0 + c"),
      );
    const hasBinBeforeEnd = optimized
      .slice(0, endLabelIndex)
      .some(
        (inst) =>
          inst.kind === "BinaryOp" && inst.toString().includes("t0 + c"),
      );

    expect(endLabelIndex).toBeGreaterThanOrEqual(0);
    expect(hasBinBeforeEnd).toBe(true);
    expect(hasBinAfterEnd).toBe(false);
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

    const optimized = performLICM(instructions);
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

  it("simplifies diamond pattern with true/false to copy of condition", () => {
    const cond = createVariable("cond", PrimitiveTypes.boolean);
    const dest = createTemporary(0, PrimitiveTypes.boolean);
    const lElse = createLabel("L_else");
    const lJoin = createLabel("L_join");
    const instructions = [
      new ConditionalJumpInstruction(cond, lElse),
      new AssignmentInstruction(
        dest,
        createConstant(true, PrimitiveTypes.boolean),
      ),
      new UnconditionalJumpInstruction(lJoin),
      new LabelInstruction(lElse),
      new AssignmentInstruction(
        dest,
        createConstant(false, PrimitiveTypes.boolean),
      ),
      new LabelInstruction(lJoin),
      new ReturnInstruction(dest),
    ];
    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);
    expect(text).not.toContain("ifFalse");
    expect(text).not.toContain("goto");
    expect(text).toContain("t0 = cond");
  });

  it("simplifies diamond pattern with false/true to negation of condition", () => {
    const cond = createVariable("cond", PrimitiveTypes.boolean);
    const dest = createTemporary(0, PrimitiveTypes.boolean);
    const lElse = createLabel("L_else");
    const lJoin = createLabel("L_join");
    const instructions = [
      new ConditionalJumpInstruction(cond, lElse),
      new AssignmentInstruction(
        dest,
        createConstant(false, PrimitiveTypes.boolean),
      ),
      new UnconditionalJumpInstruction(lJoin),
      new LabelInstruction(lElse),
      new AssignmentInstruction(
        dest,
        createConstant(true, PrimitiveTypes.boolean),
      ),
      new LabelInstruction(lJoin),
      new ReturnInstruction(dest),
    ];
    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);
    expect(text).not.toContain("ifFalse");
    expect(text).not.toContain("goto");
  });

  it("does not simplify diamond when labels have multiple uses", () => {
    const cond = createVariable("cond", PrimitiveTypes.boolean);
    const dest = createTemporary(0, PrimitiveTypes.boolean);
    const lElse = createLabel("L_else");
    const lJoin = createLabel("L_join");
    const instructions = [
      new UnconditionalJumpInstruction(lElse),
      new ConditionalJumpInstruction(cond, lElse),
      new AssignmentInstruction(
        dest,
        createConstant(true, PrimitiveTypes.boolean),
      ),
      new UnconditionalJumpInstruction(lJoin),
      new LabelInstruction(lElse),
      new AssignmentInstruction(
        dest,
        createConstant(false, PrimitiveTypes.boolean),
      ),
      new LabelInstruction(lJoin),
      new ReturnInstruction(dest),
    ];
    // Test the pass directly (not through full optimizer) to avoid other passes
    // eliminating the extra jump and reducing label usage
    const optimized = simplifyDiamondPatterns(instructions);
    const text = stringify(optimized);
    expect(text).toContain("ifFalse");
  });

  it("does not treat transform as idempotent across non-pure calls", () => {
    const obj = createVariable("obj", ExternTypes.component);
    const t0 = createTemporary(0, ExternTypes.transform);
    const t1 = createTemporary(1, PrimitiveTypes.int32);
    const t2 = createTemporary(2, ExternTypes.transform);
    const instructions = [
      new PropertyGetInstruction(t0, obj, "transform"),
      new CallInstruction(t1, "SomeExtern", []),
      new PropertyGetInstruction(t2, obj, "transform"),
      new ReturnInstruction(t2),
    ];
    const optimized = new TACOptimizer().optimize(instructions);
    expect(optimized.filter((inst) => inst.kind === "PropertyGet").length).toBe(
      2,
    );
  });

  it("simplifies multiplication by power of two to left shift", () => {
    const x = createVariable("x", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const instructions = [
      new BinaryOpInstruction(
        t0,
        x,
        "*",
        createConstant(8, PrimitiveTypes.int32),
      ),
      new ReturnInstruction(t0),
    ];
    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);
    expect(text).toContain("x << 3");
    expect(optimized.filter((inst) => inst.kind === "BinaryOp").length).toBe(1);
  });

  it("simplifies multiplication by 2 to left shift by 1", () => {
    const x = createVariable("x", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const instructions = [
      new BinaryOpInstruction(
        t0,
        x,
        "*",
        createConstant(2, PrimitiveTypes.int32),
      ),
      new ReturnInstruction(t0),
    ];
    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);
    expect(text).toContain("x << 1");
  });

  it("does not apply strength reduction for float multiplication", () => {
    const x = createVariable("x", PrimitiveTypes.single);
    const t0 = createTemporary(0, PrimitiveTypes.single);
    const instructions = [
      new BinaryOpInstruction(
        t0,
        x,
        "*",
        createConstant(4, PrimitiveTypes.single),
      ),
      new ReturnInstruction(t0),
    ];
    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);
    expect(text).not.toContain("<<");
  });

  it("converges with copy chains in loops", () => {
    const x = createVariable("x", PrimitiveTypes.int32);
    const y = createVariable("y", PrimitiveTypes.int32);
    const z = createVariable("z", PrimitiveTypes.int32);
    const cond = createVariable("cond", PrimitiveTypes.boolean);
    const lLoop = createLabel("L_loop");
    const lEnd = createLabel("L_end");

    // Block 0: x = 5; goto L_loop
    // L_loop (Block 1): y = x; z = y; ifFalse cond goto L_end; goto L_loop
    // L_end (Block 2): return z
    // Back edge: Block 1 → Block 1 creates a copy cycle opportunity
    const instructions = [
      new AssignmentInstruction(x, createConstant(5, PrimitiveTypes.int32)),
      new UnconditionalJumpInstruction(lLoop),
      new LabelInstruction(lLoop),
      new CopyInstruction(y, x),
      new CopyInstruction(z, y),
      new ConditionalJumpInstruction(cond, lEnd),
      new UnconditionalJumpInstruction(lLoop),
      new LabelInstruction(lEnd),
      new ReturnInstruction(z),
    ];

    // Should converge without hitting iteration limit and propagate constant 5
    const result = sccpAndPrune(instructions, undefined, {
      maxWorklistIterations: 100,
      onLimitReached: "break",
    });
    // Ensure the return instruction contains the propagated constant 5
    const retInst = result.find((inst) => inst.kind === "Return") as
      | ReturnInstruction
      | undefined;
    expect(retInst).toBeDefined();
    if (!retInst || !retInst.value) return;
    expect(retInst.value.kind).toBe(TACOperandKind.Constant);
    const constOp = retInst.value as ConstantOperand;
    expect(constOp.value).toBe(5);
  });

  it("converges with self-referencing copy cycles", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const b = createVariable("b", PrimitiveTypes.int32);
    const cond = createVariable("cond", PrimitiveTypes.boolean);
    const lLoop = createLabel("L_loop");
    const lEnd = createLabel("L_end");

    // a = b; b = a; in a loop creates a direct copy cycle
    const instructions = [
      new UnconditionalJumpInstruction(lLoop),
      new LabelInstruction(lLoop),
      new CopyInstruction(a, b),
      new CopyInstruction(b, a),
      new ConditionalJumpInstruction(cond, lEnd),
      new UnconditionalJumpInstruction(lLoop),
      new LabelInstruction(lEnd),
      new ReturnInstruction(a),
    ];

    // Should converge quickly without excessive iterations
    const result = sccpAndPrune(instructions, undefined, {
      maxWorklistIterations: 100,
      onLimitReached: "break",
    });
    // a and b are unknown (no constant), so return should reference a variable
    const retInst2 = result.find((inst) => inst.kind === "Return") as
      | ReturnInstruction
      | undefined;
    expect(retInst2).toBeDefined();
    if (!retInst2 || !retInst2.value) return;
    expect(retInst2.value.kind).toBe(TACOperandKind.Variable);
  });

  it("propagates copy across multiple uses", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const b = createVariable("b", PrimitiveTypes.int32);
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const t1 = createTemporary(1, PrimitiveTypes.int32);
    const instructions = [
      new CopyInstruction(b, a),
      new BinaryOpInstruction(
        t0,
        b,
        "+",
        createConstant(1, PrimitiveTypes.int32),
      ),
      new BinaryOpInstruction(
        t1,
        b,
        "*",
        createConstant(2, PrimitiveTypes.int32),
      ),
      new ReturnInstruction(t1),
    ];
    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);
    expect(text).not.toContain("b +");
    expect(text).not.toContain("b *");
  });

  it("deduplicates temporaries with same constant value", () => {
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const t1 = createTemporary(1, PrimitiveTypes.int32);
    const t2 = createTemporary(2, PrimitiveTypes.int32);
    const instructions = [
      new AssignmentInstruction(t0, createConstant(42, PrimitiveTypes.int32)),
      new AssignmentInstruction(t1, createConstant(42, PrimitiveTypes.int32)),
      new BinaryOpInstruction(t2, t0, "+", t1),
      new ReturnInstruction(t2),
    ];
    const optimized = new TACOptimizer().optimize(instructions);
    const text = stringify(optimized);
    // After dedup, t0 and t1 should reference the same temp
    // Dead code elimination removes the duplicate assignment
    const assignCount = optimized.filter(
      (inst) =>
        inst.kind === "Assignment" && inst.toString().includes("= 42"),
    ).length;
    expect(assignCount).toBeLessThanOrEqual(1);
  });

  it("sinks computation into the only branch that uses it", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const b = createVariable("b", PrimitiveTypes.int32);
    const cond = createVariable("cond", PrimitiveTypes.boolean);
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const lElse = createLabel("L_else");
    const instructions = [
      new BinaryOpInstruction(t0, a, "+", b),
      new ConditionalJumpInstruction(cond, lElse),
      new ReturnInstruction(t0),
      new LabelInstruction(lElse),
      new ReturnInstruction(a),
    ];
    const optimized = sinkCode(instructions);
    const text = stringify(optimized);
    // t0 computation should be after the conditional jump, in the then-branch
    const computeIdx = text.indexOf("t0 = a + b");
    const condIdx = text.indexOf("ifFalse");
    expect(computeIdx).toBeGreaterThan(condIdx);
  });

  it("hoists partially redundant idempotent PropertyGet via PRE", () => {
    const obj = createVariable("obj", ExternTypes.component);
    const cond = createVariable("cond", PrimitiveTypes.boolean);
    const t0 = createTemporary(0, ExternTypes.gameObject);
    const lElse = createLabel("L_else");
    const lEnd = createLabel("L_end");
    const instructions = [
      new ConditionalJumpInstruction(cond, lElse),
      new PropertyGetInstruction(t0, obj, "gameObject"),
      new UnconditionalJumpInstruction(lEnd),
      new LabelInstruction(lElse),
      new UnconditionalJumpInstruction(lEnd),
      new LabelInstruction(lEnd),
      new ReturnInstruction(t0),
    ];
    // gameObject on Component is idempotent; PRE should insert into else-branch
    const optimized = performPRE(instructions);
    const endLabelIdx = optimized.findIndex(
      (inst) => inst.kind === "Label" && inst.toString().startsWith("L_end:"),
    );
    const hasGetAfterEnd = optimized
      .slice(endLabelIdx)
      .some((inst) => inst.kind === "PropertyGet");
    expect(hasGetAfterEnd).toBe(false);
  });

  it("does not hoist transform PropertyGet via PRE", () => {
    const obj = createVariable("obj", ExternTypes.component);
    const cond = createVariable("cond", PrimitiveTypes.boolean);
    const t0 = createTemporary(0, ExternTypes.transform);
    const lElse = createLabel("L_else");
    const lEnd = createLabel("L_end");
    const instructions = [
      new ConditionalJumpInstruction(cond, lElse),
      new PropertyGetInstruction(t0, obj, "transform"),
      new UnconditionalJumpInstruction(lEnd),
      new LabelInstruction(lElse),
      new UnconditionalJumpInstruction(lEnd),
      new LabelInstruction(lEnd),
      new ReturnInstruction(t0),
    ];
    const optimized = performPRE(instructions);
    expect(
      optimized.filter((inst) => inst.kind === "PropertyGet").length,
    ).toBe(1);
  });

  it("merges identical tails ending with unconditional jump", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const cond = createVariable("cond", PrimitiveTypes.boolean);
    const lElse = createLabel("L_else");
    const lEnd = createLabel("L_end");
    const instructions = [
      new ConditionalJumpInstruction(cond, lElse),
      new AssignmentInstruction(
        a,
        createConstant(1, PrimitiveTypes.int32),
      ),
      new UnconditionalJumpInstruction(lEnd),
      new LabelInstruction(lElse),
      new AssignmentInstruction(
        a,
        createConstant(1, PrimitiveTypes.int32),
      ),
      new UnconditionalJumpInstruction(lEnd),
      new LabelInstruction(lEnd),
      new ReturnInstruction(a),
    ];
    const optimized = mergeTails(instructions);
    const text = stringify(optimized);
    expect(text).toContain("tail_merge_");
  });

  it("unswitches loop-invariant conditional", () => {
    const flag = createVariable("flag", PrimitiveTypes.boolean);
    const i = createVariable("i", PrimitiveTypes.int32);
    const a = createVariable("a", PrimitiveTypes.int32);
    const cond = createTemporary(0, PrimitiveTypes.boolean);
    const lPre = createLabel("L_pre");
    const lLoop = createLabel("L_loop");
    const lElse = createLabel("L_else");
    const lEndIf = createLabel("L_endif");
    const lEnd = createLabel("L_end");

    const instructions = [
      new LabelInstruction(lPre),
      new UnconditionalJumpInstruction(lLoop),
      new LabelInstruction(lLoop),
      new ConditionalJumpInstruction(flag, lElse),
      new BinaryOpInstruction(a, a, "+", createConstant(1, PrimitiveTypes.int32)),
      new UnconditionalJumpInstruction(lEndIf),
      new LabelInstruction(lElse),
      new BinaryOpInstruction(a, a, "+", createConstant(2, PrimitiveTypes.int32)),
      new LabelInstruction(lEndIf),
      new BinaryOpInstruction(i, i, "+", createConstant(1, PrimitiveTypes.int32)),
      new BinaryOpInstruction(cond, i, "<", createConstant(10, PrimitiveTypes.int32)),
      new ConditionalJumpInstruction(cond, lEnd),
      new UnconditionalJumpInstruction(lLoop),
      new LabelInstruction(lEnd),
      new ReturnInstruction(a),
    ];

    const optimized = unswitchLoops(instructions);
    // After unswitching, the loop should be duplicated
    // The original ifFalse flag should appear before the loops, not inside them
    // There should be more instructions than before (duplication)
    expect(optimized.length).toBeGreaterThan(instructions.length);
  });

  it("eliminates widening cast when result is only compared", () => {
    const x = createVariable("x", PrimitiveTypes.byte);
    const t0 = createTemporary(0, PrimitiveTypes.int32);
    const t1 = createTemporary(1, PrimitiveTypes.boolean);
    const instructions = [
      new CastInstruction(t0, x),
      new BinaryOpInstruction(
        t1,
        t0,
        "<",
        createConstant(10, PrimitiveTypes.int32),
      ),
      new ReturnInstruction(t1),
    ];
    const optimized = new TACOptimizer().optimize(instructions);
    expect(optimized.filter((inst) => inst.kind === "Cast").length).toBe(0);
  });
});
