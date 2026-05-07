import { describe, expect, it } from "vitest";
import {
  NativeArrayTypeSymbol,
  PrimitiveTypes,
} from "../../../src/transpiler/frontend/type_symbols";
import { readonlyArrayFolding } from "../../../src/transpiler/ir/optimizer/passes/readonly_array_folding";
import {
  ArrayAccessInstruction,
  ArrayAssignmentInstruction,
  AssignmentInstruction,
  BinaryOpInstruction,
  CallInstruction,
  ConditionalJumpInstruction,
  LabelInstruction,
  PropertyGetInstruction,
  PropertySetInstruction,
  ReturnInstruction,
} from "../../../src/transpiler/ir/tac_instruction";
import {
  createConstant,
  createLabel,
  createTemporary,
  createVariable,
} from "../../../src/transpiler/ir/tac_operand";

const int32ArrayType = new NativeArrayTypeSymbol(PrimitiveTypes.int32);
const singleArrayType = new NativeArrayTypeSymbol(PrimitiveTypes.single);
const boolArrayType = new NativeArrayTypeSymbol(PrimitiveTypes.boolean);
const stringArrayType = new NativeArrayTypeSymbol(PrimitiveTypes.string);

const c = (v: number, type = PrimitiveTypes.int32) => createConstant(v, type);
const t = (id: number, type = PrimitiveTypes.int32) =>
  createTemporary(id, type);
const tArr = (id: number) => createTemporary(id, int32ArrayType);
const v = (
  name: string,
  type = PrimitiveTypes.int32,
  meta?: { isExported?: boolean },
) => createVariable(name, type, meta);
const vArr = (name: string, meta?: { isExported?: boolean }) =>
  createVariable(name, int32ArrayType, meta);
const label = (name: string) => new LabelInstruction(createLabel(name));

const stringify = (insts: { toString(): string }[]) =>
  insts.map((inst) => inst.toString()).join("\n");

describe("readonlyArrayFolding", () => {
  it("folds constant-index access on a readonly array and removes init", () => {
    const arr = tArr(0);
    const alias = vArr("scores");
    const dest = t(1);
    const instructions = [
      new CallInstruction(arr, "__ctor_SystemInt32Array", [c(3)]),
      new ArrayAssignmentInstruction(arr, c(0), c(10)),
      new ArrayAssignmentInstruction(arr, c(1), c(20)),
      new ArrayAssignmentInstruction(arr, c(2), c(30)),
      new AssignmentInstruction(alias, arr),
      new ArrayAccessInstruction(dest, alias, c(0)),
    ];

    const result = readonlyArrayFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    expect(text).toContain("t1 = 10");
    expect(text).not.toContain("__ctor_SystemInt32Array");
    expect(text).not.toContain("scores[0]");
  });

  it("folds direct temp access without alias", () => {
    const arr = tArr(0);
    const dest = t(1);
    const instructions = [
      new CallInstruction(arr, "__ctor_SystemInt32Array", [c(2)]),
      new ArrayAssignmentInstruction(arr, c(0), c(42)),
      new ArrayAssignmentInstruction(arr, c(1), c(99)),
      new ArrayAccessInstruction(dest, arr, c(1)),
    ];

    const result = readonlyArrayFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    expect(text).toContain("t1 = 99");
    expect(text).not.toContain("__ctor_SystemInt32Array");
  });

  it("preserves non-constant index access and keeps init", () => {
    const arr = tArr(0);
    const alias = vArr("scores");
    const idx = v("i");
    const dest1 = t(1);
    const dest2 = t(2);
    const instructions = [
      new CallInstruction(arr, "__ctor_SystemInt32Array", [c(2)]),
      new ArrayAssignmentInstruction(arr, c(0), c(10)),
      new ArrayAssignmentInstruction(arr, c(1), c(20)),
      new AssignmentInstruction(alias, arr),
      new ArrayAccessInstruction(dest1, alias, c(0)),
      new ArrayAccessInstruction(dest2, alias, idx),
    ];

    const result = readonlyArrayFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    expect(text).toContain("t1 = 10");
    expect(text).toContain("scores[i]");
    expect(text).toContain("__ctor_SystemInt32Array");
  });

  it("handles non-constant init value (partial fold)", () => {
    const arr = tArr(0);
    const alias = vArr("scores");
    const dynamic = v("x");
    const dest1 = t(1);
    const dest2 = t(2);
    const instructions = [
      new CallInstruction(arr, "__ctor_SystemInt32Array", [c(2)]),
      new ArrayAssignmentInstruction(arr, c(0), dynamic),
      new ArrayAssignmentInstruction(arr, c(1), c(20)),
      new AssignmentInstruction(alias, arr),
      new ArrayAccessInstruction(dest1, alias, c(0)),
      new ArrayAccessInstruction(dest2, alias, c(1)),
    ];

    const result = readonlyArrayFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    expect(text).toContain("scores[0]");
    expect(text).toContain("t2 = 20");
  });

  it("invalidates candidate on non-constant init index", () => {
    const arr = tArr(0);
    const alias = vArr("scores");
    const idx = v("i");
    const dest = t(1);
    const instructions = [
      new CallInstruction(arr, "__ctor_SystemInt32Array", [c(2)]),
      new ArrayAssignmentInstruction(arr, idx, c(10)),
      new AssignmentInstruction(alias, arr),
      new ArrayAccessInstruction(dest, alias, c(0)),
    ];

    const result = readonlyArrayFolding(instructions);
    expect(result.changed).toBe(false);
  });

  it("invalidates on post-init ArrayAssignment", () => {
    const arr = tArr(0);
    const alias = vArr("scores");
    const dest = t(1);
    const instructions = [
      new CallInstruction(arr, "__ctor_SystemInt32Array", [c(2)]),
      new ArrayAssignmentInstruction(arr, c(0), c(10)),
      new AssignmentInstruction(alias, arr),
      new ArrayAssignmentInstruction(alias, c(0), c(99)),
      new ArrayAccessInstruction(dest, alias, c(0)),
    ];

    const result = readonlyArrayFolding(instructions);
    expect(result.changed).toBe(false);
  });

  it("invalidates on alias reassignment", () => {
    const arr = tArr(0);
    const alias = vArr("scores");
    const other = tArr(5);
    const dest = t(1);
    const instructions = [
      new CallInstruction(arr, "__ctor_SystemInt32Array", [c(2)]),
      new ArrayAssignmentInstruction(arr, c(0), c(10)),
      new AssignmentInstruction(alias, arr),
      new AssignmentInstruction(alias, other),
      new ArrayAccessInstruction(dest, alias, c(0)),
    ];

    const result = readonlyArrayFolding(instructions);
    expect(result.changed).toBe(false);
  });

  it("invalidates when array passed as Call arg", () => {
    const arr = tArr(0);
    const alias = vArr("scores");
    const dest = t(1);
    const instructions = [
      new CallInstruction(arr, "__ctor_SystemInt32Array", [c(2)]),
      new ArrayAssignmentInstruction(arr, c(0), c(10)),
      new AssignmentInstruction(alias, arr),
      new CallInstruction(undefined, "someFunc", [alias]),
      new ArrayAccessInstruction(dest, alias, c(0)),
    ];

    const result = readonlyArrayFolding(instructions);
    expect(result.changed).toBe(false);
  });

  it("invalidates on PropertySet", () => {
    const arr = tArr(0);
    const alias = vArr("scores");
    const dest = t(1);
    const instructions = [
      new CallInstruction(arr, "__ctor_SystemInt32Array", [c(1)]),
      new ArrayAssignmentInstruction(arr, c(0), c(10)),
      new AssignmentInstruction(alias, arr),
      new PropertySetInstruction(alias, "Length", c(5)),
      new ArrayAccessInstruction(dest, alias, c(0)),
    ];

    const result = readonlyArrayFolding(instructions);
    expect(result.changed).toBe(false);
  });

  it("keeps init on PropertyGet (.Length) residual use", () => {
    const arr = tArr(0);
    const alias = vArr("scores");
    const dest1 = t(1);
    const dest2 = t(2);
    const instructions = [
      new CallInstruction(arr, "__ctor_SystemInt32Array", [c(2)]),
      new ArrayAssignmentInstruction(arr, c(0), c(10)),
      new ArrayAssignmentInstruction(arr, c(1), c(20)),
      new AssignmentInstruction(alias, arr),
      new ArrayAccessInstruction(dest1, alias, c(0)),
      new PropertyGetInstruction(dest2, alias, "Length"),
    ];

    const result = readonlyArrayFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    expect(text).toContain("t1 = 10");
    expect(text).toContain("__ctor_SystemInt32Array");
    expect(text).toContain("scores.Length");
  });

  it("folds two interleaved arrays independently", () => {
    const arr1 = tArr(0);
    const arr2 = createTemporary(1, singleArrayType);
    const alias1 = vArr("a");
    const alias2 = createVariable("b", singleArrayType);
    const dest1 = t(10);
    const dest2 = createTemporary(11, PrimitiveTypes.single);
    const instructions = [
      new CallInstruction(arr1, "__ctor_SystemInt32Array", [c(1)]),
      new CallInstruction(arr2, "__ctor_SystemSingleArray", [c(1)]),
      new ArrayAssignmentInstruction(arr1, c(0), c(42)),
      new ArrayAssignmentInstruction(
        arr2,
        c(0),
        createConstant(3.14, PrimitiveTypes.single),
      ),
      new AssignmentInstruction(alias1, arr1),
      new AssignmentInstruction(alias2, arr2),
      new ArrayAccessInstruction(dest1, alias1, c(0)),
      new ArrayAccessInstruction(dest2, alias2, c(0)),
    ];

    const result = readonlyArrayFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    expect(text).toContain("t10 = 42");
    expect(text).toContain("t11 = 3.14");
    expect(text).not.toContain("__ctor_");
  });

  it("uses last-write-wins for duplicate index", () => {
    const arr = tArr(0);
    const alias = vArr("scores");
    const dest = t(1);
    const instructions = [
      new CallInstruction(arr, "__ctor_SystemInt32Array", [c(1)]),
      new ArrayAssignmentInstruction(arr, c(0), c(10)),
      new ArrayAssignmentInstruction(arr, c(0), c(20)),
      new AssignmentInstruction(alias, arr),
      new ArrayAccessInstruction(dest, alias, c(0)),
    ];

    const result = readonlyArrayFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    expect(text).toContain("t1 = 20");
  });

  it("handles empty array as no-op", () => {
    const arr = tArr(0);
    const alias = vArr("scores");
    const instructions = [
      new CallInstruction(arr, "__ctor_SystemInt32Array", [c(0)]),
      new AssignmentInstruction(alias, arr),
    ];

    const result = readonlyArrayFolding(instructions);
    expect(result.changed).toBe(false);
  });

  it("clears candidates at exposedLabel boundary (multi-method)", () => {
    // Both methods use the same alias name "scores" - exposedLabel
    // must clear the first candidate so the second one is tracked independently
    const arr1 = tArr(0);
    const alias1 = vArr("scores");
    const arr2 = tArr(5);
    const alias2 = vArr("scores");
    const dest1 = t(1);
    const dest2 = t(2);
    const exposedLabels = new Set(["method_B"]);
    const instructions = [
      new CallInstruction(arr1, "__ctor_SystemInt32Array", [c(1)]),
      new ArrayAssignmentInstruction(arr1, c(0), c(10)),
      new AssignmentInstruction(alias1, arr1),
      new ArrayAccessInstruction(dest1, alias1, c(0)),
      new ReturnInstruction(dest1),
      label("method_B"),
      new CallInstruction(arr2, "__ctor_SystemInt32Array", [c(1)]),
      new ArrayAssignmentInstruction(arr2, c(0), c(99)),
      new AssignmentInstruction(alias2, arr2),
      new ArrayAccessInstruction(dest2, alias2, c(0)),
    ];

    const result = readonlyArrayFolding(instructions, exposedLabels);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    // First method's array should be folded
    expect(text).toContain("t1 = 10");
    // Second method's array should also be folded independently
    expect(text).toContain("t2 = 99");
  });

  it("invalidates on isExported alias", () => {
    const arr = tArr(0);
    const alias = vArr("scores", { isExported: true });
    const dest = t(1);
    const instructions = [
      new CallInstruction(arr, "__ctor_SystemInt32Array", [c(1)]),
      new ArrayAssignmentInstruction(arr, c(0), c(10)),
      new AssignmentInstruction(alias, arr),
      new ArrayAccessInstruction(dest, alias, c(0)),
    ];

    const result = readonlyArrayFolding(instructions);
    expect(result.changed).toBe(false);
  });

  it("returns changed: false when no candidates exist", () => {
    const x = v("x");
    const y = v("y");
    const instructions = [
      new AssignmentInstruction(x, c(10)),
      new AssignmentInstruction(y, c(20)),
    ];

    const result = readonlyArrayFolding(instructions);
    expect(result.changed).toBe(false);
    expect(result.instructions).toBe(instructions);
  });

  it("folds both segments when tempId collides across exposed labels", () => {
    // Both methods reuse tempId=0 for their array constructor
    const arr1 = tArr(0);
    const alias1 = vArr("data");
    const arr2 = tArr(0);
    const alias2 = vArr("data");
    const dest1 = t(1);
    const dest2 = t(2);
    const exposedLabels = new Set(["method_B"]);
    const instructions = [
      new CallInstruction(arr1, "__ctor_SystemInt32Array", [c(1)]),
      new ArrayAssignmentInstruction(arr1, c(0), c(10)),
      new AssignmentInstruction(alias1, arr1),
      new ArrayAccessInstruction(dest1, alias1, c(0)),
      new ReturnInstruction(dest1),
      label("method_B"),
      new CallInstruction(arr2, "__ctor_SystemInt32Array", [c(1)]),
      new ArrayAssignmentInstruction(arr2, c(0), c(99)),
      new AssignmentInstruction(alias2, arr2),
      new ArrayAccessInstruction(dest2, alias2, c(0)),
    ];

    const result = readonlyArrayFolding(instructions, exposedLabels);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    expect(text).toContain("t1 = 10");
    expect(text).toContain("t2 = 99");
    expect(text).not.toContain("__ctor_SystemInt32Array");
  });

  it("invalidates when ConditionalJump condition uses candidate temp", () => {
    const arr = tArr(0);
    const alias = vArr("scores");
    const dest = t(1);
    const lbl = createLabel("skip");
    const instructions = [
      new CallInstruction(arr, "__ctor_SystemInt32Array", [c(1)]),
      new ArrayAssignmentInstruction(arr, c(0), c(10)),
      new ConditionalJumpInstruction(arr, lbl),
      new AssignmentInstruction(alias, arr),
      new ArrayAccessInstruction(dest, alias, c(0)),
    ];

    const result = readonlyArrayFolding(instructions);
    expect(result.changed).toBe(false);
  });

  it("does not set structurallyChanged when only accesses are replaced", () => {
    const arr = tArr(0);
    const alias = vArr("scores");
    const dest1 = t(1);
    const dest2 = t(2);
    const idx = v("i");
    const instructions = [
      new CallInstruction(arr, "__ctor_SystemInt32Array", [c(2)]),
      new ArrayAssignmentInstruction(arr, c(0), c(10)),
      new ArrayAssignmentInstruction(arr, c(1), c(20)),
      new AssignmentInstruction(alias, arr),
      new ArrayAccessInstruction(dest1, alias, c(0)),
      new ArrayAccessInstruction(dest2, alias, idx),
    ];

    const result = readonlyArrayFolding(instructions);
    expect(result.changed).toBe(true);
    // Init code preserved because of non-constant index access residual use
    expect(result.structurallyChanged).toBeUndefined();
  });

  // --- Type-default folding for uninitialized slots ---

  it("folds uninitialized slots of a number[] to 0", () => {
    const arr = tArr(0);
    const dest1 = t(1);
    const dest2 = t(2);
    const instructions = [
      new CallInstruction(arr, "__ctor_SystemInt32Array", [c(3)]),
      new ArrayAssignmentInstruction(arr, c(0), c(10)),
      new ArrayAccessInstruction(dest1, arr, c(1)),
      new ArrayAccessInstruction(dest2, arr, c(2)),
    ];

    const result = readonlyArrayFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    expect(text).toContain("t1 = 0");
    expect(text).toContain("t2 = 0");
  });

  it("folds mixed array: explicit write and uninitialized slot both fold", () => {
    const arr = tArr(0);
    const dest0 = t(1);
    const dest1 = t(2);
    const instructions = [
      new CallInstruction(arr, "__ctor_SystemInt32Array", [c(2)]),
      new ArrayAssignmentInstruction(arr, c(0), c(42)),
      new ArrayAccessInstruction(dest0, arr, c(0)),
      new ArrayAccessInstruction(dest1, arr, c(1)),
    ];

    const result = readonlyArrayFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    expect(text).toContain("t1 = 42");
    expect(text).toContain("t2 = 0");
    expect(text).not.toContain("__ctor_SystemInt32Array");
  });

  it("does not fold out-of-bounds uninitialized index", () => {
    const arr = tArr(0);
    const dest = t(1);
    const instructions = [
      new CallInstruction(arr, "__ctor_SystemInt32Array", [c(2)]),
      new ArrayAccessInstruction(dest, arr, c(2)),
    ];

    const result = readonlyArrayFolding(instructions);
    expect(result.changed).toBe(false);
    const text = stringify(result.instructions);
    expect(text).toContain("t1 = t0[2]");
  });

  it("does not fold non-constant write but does fold uninitialized slot in same array", () => {
    const arr = tArr(0);
    const nonConst = v("x");
    const dest0 = t(1);
    const dest1 = t(2);
    const instructions = [
      new CallInstruction(arr, "__ctor_SystemInt32Array", [c(2)]),
      new ArrayAssignmentInstruction(arr, c(0), nonConst),
      new ArrayAccessInstruction(dest0, arr, c(0)),
      new ArrayAccessInstruction(dest1, arr, c(1)),
    ];

    const result = readonlyArrayFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    expect(text).toContain("t1 = t0[0]");
    expect(text).toContain("t2 = 0");
  });

  it("folds uninitialized boolean[] slot to false", () => {
    const arr = createTemporary(0, boolArrayType);
    const dest = createTemporary(1, PrimitiveTypes.boolean);
    const instructions = [
      new CallInstruction(arr, "__ctor_SystemBooleanArray", [c(2)]),
      new ArrayAccessInstruction(dest, arr, c(0)),
    ];

    const result = readonlyArrayFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    expect(text).toContain("t1 = false");
    expect(text).not.toContain("__ctor_SystemBooleanArray");
  });

  it("folds uninitialized string[] slot to null", () => {
    const arr = createTemporary(0, stringArrayType);
    const dest = createTemporary(1, PrimitiveTypes.string);
    const instructions = [
      new CallInstruction(arr, "__ctor_SystemStringArray", [c(2)]),
      new ArrayAccessInstruction(dest, arr, c(0)),
    ];

    const result = readonlyArrayFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    expect(text).toContain("t1 = null");
    expect(text).not.toContain("__ctor_SystemStringArray");
  });

  it("removes all init instructions when all slots fold (explicit + default)", () => {
    const arr = tArr(0);
    const dest0 = t(1);
    const dest1 = t(2);
    const dest2 = t(3);
    const instructions = [
      new CallInstruction(arr, "__ctor_SystemInt32Array", [c(3)]),
      new ArrayAssignmentInstruction(arr, c(0), c(7)),
      new ArrayAccessInstruction(dest0, arr, c(0)),
      new ArrayAccessInstruction(dest1, arr, c(1)),
      new ArrayAccessInstruction(dest2, arr, c(2)),
    ];

    const result = readonlyArrayFolding(instructions);
    expect(result.changed).toBe(true);
    expect(result.structurallyChanged).toBe(true);
    const text = stringify(result.instructions);
    expect(text).toContain("t1 = 7");
    expect(text).toContain("t2 = 0");
    expect(text).toContain("t3 = 0");
    expect(text).not.toContain("__ctor_SystemInt32Array");
    expect(text).not.toContain("ArrayAssignment");
  });

  it("invalidates on init-phase catch-all (BinaryOp using temp)", () => {
    const arr = tArr(0);
    const alias = vArr("scores");
    const dest = t(1);
    const bogus = t(2);
    const instructions = [
      new CallInstruction(arr, "__ctor_SystemInt32Array", [c(1)]),
      new ArrayAssignmentInstruction(arr, c(0), c(10)),
      new BinaryOpInstruction(bogus, arr, "+", c(1)),
      new AssignmentInstruction(alias, arr),
      new ArrayAccessInstruction(dest, alias, c(0)),
    ];

    const result = readonlyArrayFolding(instructions);
    expect(result.changed).toBe(false);
  });
});
