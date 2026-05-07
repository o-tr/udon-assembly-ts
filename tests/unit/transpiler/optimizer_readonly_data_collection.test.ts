import { describe, expect, it } from "vitest";
import {
  ExternTypes,
  PrimitiveTypes,
} from "../../../src/transpiler/frontend/type_symbols";
import { readonlyDataCollectionFolding } from "../../../src/transpiler/ir/optimizer/passes/readonly_data_collection_folding";
import {
  AssignmentInstruction,
  CallInstruction,
  ConditionalJumpInstruction,
  LabelInstruction,
  MethodCallInstruction,
  PropertyGetInstruction,
  PropertySetInstruction,
} from "../../../src/transpiler/ir/tac_instruction";
import {
  createConstant,
  createLabel,
  createTemporary,
  createVariable,
} from "../../../src/transpiler/ir/tac_operand";

const dlType = ExternTypes.dataList;
const ddType = ExternTypes.dataDictionary;
const dtType = ExternTypes.dataToken;

const cStr = (v: string) => createConstant(v, PrimitiveTypes.string);
const cInt = (v: number) => createConstant(v, PrimitiveTypes.int32);
const cBool = (v: boolean) => createConstant(v, PrimitiveTypes.boolean);
const cFloat = (v: number) => createConstant(v, PrimitiveTypes.single);

const tDL = (id: number) => createTemporary(id, dlType);
const tDD = (id: number) => createTemporary(id, ddType);
const tDT = (id: number) => createTemporary(id, dtType);
const tStr = (id: number) => createTemporary(id, PrimitiveTypes.string);
const tInt = (id: number) => createTemporary(id, PrimitiveTypes.int32);
const tBool = (id: number) => createTemporary(id, PrimitiveTypes.boolean);
const tFloat = (id: number) => createTemporary(id, PrimitiveTypes.single);

const vDL = (name: string, meta?: { isExported?: boolean }) =>
  createVariable(name, dlType, meta);
const _vDD = (name: string) => createVariable(name, ddType);
const _vStr = (name: string) => createVariable(name, PrimitiveTypes.string);

const label = (name: string) => new LabelInstruction(createLabel(name));

// Extern sig constants (arbitrary strings — the pass copies them verbatim)
const DT_STR_SIG =
  "VRCSDK3DataDataToken.__ctor__SystemString__VRCSDK3DataDataToken";
const DT_INT_SIG =
  "VRCSDK3DataDataToken.__ctor__SystemInt32__VRCSDK3DataDataToken";
const DT_BOOL_SIG =
  "VRCSDK3DataDataToken.__ctor__SystemBoolean__VRCSDK3DataDataToken";
const DT_FLOAT_SIG =
  "VRCSDK3DataDataToken.__ctor__SystemSingle__VRCSDK3DataDataToken";
const _DT_DOUBLE_SIG =
  "VRCSDK3DataDataToken.__ctor__SystemDouble__VRCSDK3DataDataToken";

const stringify = (insts: { toString(): string }[]) =>
  insts.map((i) => i.toString()).join("\n");

describe("readonlyDataCollectionFolding", () => {
  // ---- DataList tests ----

  it("folds get_Item on a readonly DataList and removes init", () => {
    const dl = tDL(0);
    const tok = tDT(1);
    const dest = tDT(2);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new CallInstruction(tok, DT_STR_SIG, [cStr("hello")]),
      new MethodCallInstruction(undefined, dl, "Add", [tok]),
      new MethodCallInstruction(dest, dl, "get_Item", [cInt(0)]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    // Init instructions removed; get_Item replaced with DataToken ctor
    expect(text).toContain(`${DT_STR_SIG}("hello")`);
    expect(text).not.toContain("DataList.__ctor__");
    expect(text).not.toContain("Add");
    expect(text).not.toContain("get_Item");
  });

  it("folds get_Item via alias", () => {
    const dl = tDL(0);
    const alias = vDL("scores");
    const tok = tDT(1);
    const dest = tDT(2);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new CallInstruction(tok, DT_STR_SIG, [cStr("a")]),
      new MethodCallInstruction(undefined, dl, "Add", [tok]),
      new AssignmentInstruction(alias, dl),
      new MethodCallInstruction(dest, alias, "get_Item", [cInt(0)]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    expect(text).toContain(DT_STR_SIG);
    expect(text).not.toContain("get_Item");
    expect(text).not.toContain("DataList.__ctor__");
  });

  it("does not fold get_Item with non-constant index and preserves init", () => {
    const dl = tDL(0);
    const tok = tDT(1);
    const dest = tDT(2);
    const idx = tInt(3);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new CallInstruction(tok, DT_STR_SIG, [cStr("x")]),
      new MethodCallInstruction(undefined, dl, "Add", [tok]),
      new MethodCallInstruction(dest, dl, "get_Item", [idx]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(false);
    expect(result.instructions).toBe(instructions);
  });

  it("invalidates DataList after post-init Add", () => {
    const dl = tDL(0);
    const tok = tDT(1);
    const alias = vDL("list");
    const dest = tDT(2);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new CallInstruction(tok, DT_STR_SIG, [cStr("a")]),
      new MethodCallInstruction(undefined, dl, "Add", [tok]),
      new AssignmentInstruction(alias, dl),
      // post-init Add — invalidates the candidate
      new MethodCallInstruction(undefined, alias, "Add", [tok]),
      new MethodCallInstruction(dest, alias, "get_Item", [cInt(0)]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(false);
  });

  // ---- DataDictionary tests ----

  it("folds GetValue on a readonly DataDictionary and removes init", () => {
    const dd = tDD(0);
    const kTok = tDT(1);
    const vTok = tDT(2);
    const dest = tDT(3);

    const instructions = [
      new CallInstruction(dd, "DataDictionary.__ctor__", []),
      new CallInstruction(kTok, DT_STR_SIG, [cStr("name")]),
      new CallInstruction(vTok, DT_STR_SIG, [cStr("Alice")]),
      new MethodCallInstruction(undefined, dd, "SetValue", [kTok, vTok]),
      new MethodCallInstruction(dest, dd, "GetValue", [kTok]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    expect(text).toContain(`${DT_STR_SIG}("Alice")`);
    expect(text).not.toContain("DataDictionary.__ctor__");
    expect(text).not.toContain("SetValue");
    expect(text).not.toContain("GetValue");
  });

  it("folds ContainsKey to true when key exists", () => {
    const dd = tDD(0);
    const kTok = tDT(1);
    const vTok = tDT(2);
    const hasDest = tBool(3);

    const instructions = [
      new CallInstruction(dd, "DataDictionary.__ctor__", []),
      new CallInstruction(kTok, DT_STR_SIG, [cStr("x")]),
      new CallInstruction(vTok, DT_INT_SIG, [cInt(42)]),
      new MethodCallInstruction(undefined, dd, "SetValue", [kTok, vTok]),
      new MethodCallInstruction(hasDest, dd, "ContainsKey", [kTok]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    expect(text).toContain("true");
    expect(text).not.toContain("ContainsKey");
  });

  it("folds ContainsKey to false when key is not present", () => {
    const dd = tDD(0);
    const kPresent = tDT(1);
    const vTok = tDT(2);
    const kAbsent = tDT(3);
    const hasDest = tBool(4);

    const instructions = [
      new CallInstruction(dd, "DataDictionary.__ctor__", []),
      new CallInstruction(kPresent, DT_STR_SIG, [cStr("a")]),
      new CallInstruction(vTok, DT_INT_SIG, [cInt(1)]),
      new MethodCallInstruction(undefined, dd, "SetValue", [kPresent, vTok]),
      new CallInstruction(kAbsent, DT_STR_SIG, [cStr("b")]),
      new MethodCallInstruction(hasDest, dd, "ContainsKey", [kAbsent]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    expect(text).toContain("false");
    expect(text).not.toContain("ContainsKey");
  });

  it("does not fold ContainsKey when key token is not a known DataToken", () => {
    const dd = tDD(0);
    const kTok = tDT(1);
    const vTok = tDT(2);
    const unknownKey = tDT(5); // not in dataTokenDefs
    const hasDest = tBool(3);

    const instructions = [
      new CallInstruction(dd, "DataDictionary.__ctor__", []),
      new CallInstruction(kTok, DT_STR_SIG, [cStr("a")]),
      new CallInstruction(vTok, DT_INT_SIG, [cInt(1)]),
      new MethodCallInstruction(undefined, dd, "SetValue", [kTok, vTok]),
      // unknownKey has non-constant origin (not emitted as DataToken ctor with Constant arg)
      new MethodCallInstruction(hasDest, dd, "ContainsKey", [unknownKey]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(false);
  });

  it("tracks key presence even when value is null (DataToken passthrough)", () => {
    const dd = tDD(0);
    const kTok = tDT(1);
    // Value is passed as a non-DataToken-ctor temp (passthrough), so not in dataTokenDefs
    const vTok = tDT(2);
    const hasDest = tBool(3);
    const valDest = tDT(4);

    const instructions = [
      new CallInstruction(dd, "DataDictionary.__ctor__", []),
      new CallInstruction(kTok, DT_STR_SIG, [cStr("key")]),
      // vTok is NOT from a DataToken ctor with Constant arg → value is null in contents
      new MethodCallInstruction(undefined, dd, "SetValue", [kTok, vTok]),
      // ContainsKey can still be folded (key is tracked)
      new MethodCallInstruction(hasDest, dd, "ContainsKey", [kTok]),
      // GetValue cannot be folded (value is null)
      new MethodCallInstruction(valDest, dd, "GetValue", [kTok]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    // ContainsKey folded to true
    expect(text).toContain("true");
    // GetValue NOT folded
    expect(text).toContain("GetValue");
  });

  // ---- PropertyGet folding tests ----

  it("folds get_Item + PropertyGet(.String) to AssignmentInstruction", () => {
    const dl = tDL(0);
    const tok = tDT(1);
    const dtResult = tDT(2);
    const strResult = tStr(3);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new CallInstruction(tok, DT_STR_SIG, [cStr("world")]),
      new MethodCallInstruction(undefined, dl, "Add", [tok]),
      new MethodCallInstruction(dtResult, dl, "get_Item", [cInt(0)]),
      new PropertyGetInstruction(strResult, dtResult, "String"),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    // Fully folded: PropertyGet replaced with assignment from constant ("t3" = id 3)
    expect(text).toContain('t3 = "world"');
    expect(text).not.toContain("get_Item");
    expect(text).not.toContain(".String");
  });

  it("does not fold PropertyGet for Int type (null-check diamond present)", () => {
    const dl = tDL(0);
    const tok = tDT(1);
    const dtResult = tDT(2);
    const intResult = tInt(3);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new CallInstruction(tok, DT_INT_SIG, [cInt(99)]),
      new MethodCallInstruction(undefined, dl, "Add", [tok]),
      new MethodCallInstruction(dtResult, dl, "get_Item", [cInt(0)]),
      // For Int, unwrapDataToken emits IsNull check first (not a direct PropertyGet(.Int))
      new PropertyGetInstruction(intResult, dtResult, "IsNull"),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    // get_Item replaced with DataToken ctor, but PropertyGet(.IsNull) is NOT folded
    expect(text).toContain(DT_INT_SIG);
    expect(text).not.toContain("get_Item");
    // IsNull check remains
    expect(text).toContain("IsNull");
  });

  it("folds Boolean type — get_Item + PropertyGet(.Boolean)", () => {
    const dl = tDL(0);
    const tok = tDT(1);
    const dtResult = tDT(2);
    const boolResult = tBool(3);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new CallInstruction(tok, DT_BOOL_SIG, [cBool(true)]),
      new MethodCallInstruction(undefined, dl, "Add", [tok]),
      new MethodCallInstruction(dtResult, dl, "get_Item", [cInt(0)]),
      new PropertyGetInstruction(boolResult, dtResult, "Boolean"),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    expect(text).toContain("t3 = true");
    expect(text).not.toContain("get_Item");
    expect(text).not.toContain(".Boolean");
  });

  it("folds Float type — get_Item + PropertyGet(.Float)", () => {
    const dl = tDL(0);
    const tok = tDT(1);
    const dtResult = tDT(2);
    const floatResult = tFloat(3);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new CallInstruction(tok, DT_FLOAT_SIG, [cFloat(3.14)]),
      new MethodCallInstruction(undefined, dl, "Add", [tok]),
      new MethodCallInstruction(dtResult, dl, "get_Item", [cInt(0)]),
      new PropertyGetInstruction(floatResult, dtResult, "Float"),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    expect(text).toContain("t3 = 3.14");
    expect(text).not.toContain("get_Item");
    expect(text).not.toContain(".Float");
  });

  // ---- Common / shared behavior tests ----

  it("handles mixed DataList and DataDictionary independently", () => {
    const dl = tDL(0);
    const dd = tDD(1);
    const tok1 = tDT(2);
    const tok2 = tDT(3);
    const tok3 = tDT(4);
    const dlDest = tDT(5);
    const ddDest = tDT(6);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new CallInstruction(tok1, DT_STR_SIG, [cStr("list-val")]),
      new MethodCallInstruction(undefined, dl, "Add", [tok1]),
      new CallInstruction(dd, "DataDictionary.__ctor__", []),
      new CallInstruction(tok2, DT_STR_SIG, [cStr("key")]),
      new CallInstruction(tok3, DT_STR_SIG, [cStr("dict-val")]),
      new MethodCallInstruction(undefined, dd, "SetValue", [tok2, tok3]),
      new MethodCallInstruction(dlDest, dl, "get_Item", [cInt(0)]),
      new MethodCallInstruction(ddDest, dd, "GetValue", [tok2]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    expect(text).not.toContain("DataList.__ctor__");
    expect(text).not.toContain("DataDictionary.__ctor__");
    expect(text).not.toContain("get_Item");
    expect(text).not.toContain("GetValue");
    // Both replaced with DataToken ctors
    expect(
      result.instructions.filter((inst) => inst.toString().includes(DT_STR_SIG))
        .length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("respects exposed label boundaries between methods", () => {
    const dl0 = tDL(0);
    const tok0 = tDT(1);
    const dest0 = tDT(2);
    const dl1 = tDL(0); // same tempId reused after method boundary
    const tok1 = tDT(3);
    const dest1 = tDT(4);

    const exposed = new Set(["method_b"]);
    const instructions = [
      // Method A
      new CallInstruction(dl0, "DataList.__ctor__", []),
      new CallInstruction(tok0, DT_STR_SIG, [cStr("a")]),
      new MethodCallInstruction(undefined, dl0, "Add", [tok0]),
      new MethodCallInstruction(dest0, dl0, "get_Item", [cInt(0)]),
      label("method_b"),
      // Method B — same tempId but different scope
      new CallInstruction(dl1, "DataList.__ctor__", []),
      new CallInstruction(tok1, DT_STR_SIG, [cStr("b")]),
      new MethodCallInstruction(undefined, dl1, "Add", [tok1]),
      new MethodCallInstruction(dest1, dl1, "get_Item", [cInt(0)]),
    ];

    const result = readonlyDataCollectionFolding(instructions, exposed);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    // Both methods should have their DataList init removed and get_Item replaced
    expect(text).not.toContain("DataList.__ctor__");
    expect(text).not.toContain("get_Item");
  });

  it("invalidates on PropertySet targeting the collection", () => {
    const dl = tDL(0);
    const tok = tDT(1);
    const dest = tDT(2);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new CallInstruction(tok, DT_STR_SIG, [cStr("x")]),
      new MethodCallInstruction(undefined, dl, "Add", [tok]),
      new AssignmentInstruction(vDL("alias"), dl),
      // PropertySet on alias invalidates
      new PropertySetInstruction(vDL("alias"), "SomeField", cStr("y")),
      new MethodCallInstruction(dest, vDL("alias"), "get_Item", [cInt(0)]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(false);
  });

  it("invalidates when DataList is passed as arg to another call", () => {
    const dl = tDL(0);
    const tok = tDT(1);
    const dest = tDT(2);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new CallInstruction(tok, DT_STR_SIG, [cStr("x")]),
      new MethodCallInstruction(undefined, dl, "Add", [tok]),
      new AssignmentInstruction(vDL("alias"), dl),
      // Passing alias as arg to a Call — should invalidate
      new CallInstruction(dest, "SomeExtern", [vDL("alias")]),
      new MethodCallInstruction(tDT(3), vDL("alias"), "get_Item", [cInt(0)]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(false);
  });

  it("invalidates on exported alias", () => {
    const dl = tDL(0);
    const tok = tDT(1);
    const exportedAlias = createVariable("scores", dlType, {
      isExported: true,
    });
    const dest = tDT(2);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new CallInstruction(tok, DT_STR_SIG, [cStr("z")]),
      new MethodCallInstruction(undefined, dl, "Add", [tok]),
      new AssignmentInstruction(exportedAlias, dl),
      new MethodCallInstruction(dest, exportedAlias, "get_Item", [cInt(0)]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(false);
  });

  it("returns changed:false and same reference for empty collection with no reads", () => {
    const dl = tDL(0);

    const instructions = [new CallInstruction(dl, "DataList.__ctor__", [])];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(false);
    expect(result.instructions).toBe(instructions);
  });

  it("preserves init when residual use (Count property read) remains", () => {
    const dl = tDL(0);
    const alias = vDL("list");
    const tok = tDT(1);
    const dest = tDT(2);
    const count = tInt(3);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new CallInstruction(tok, DT_STR_SIG, [cStr("item")]),
      new MethodCallInstruction(undefined, dl, "Add", [tok]),
      new AssignmentInstruction(alias, dl),
      // Fold this access
      new MethodCallInstruction(dest, alias, "get_Item", [cInt(0)]),
      // But there's a residual Count read — init must be preserved
      new PropertyGetInstruction(count, alias, "Count"),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    // get_Item is replaced
    expect(text).not.toContain("get_Item");
    // Init instructions remain because of Count read
    expect(text).toContain("DataList.__ctor__");
    expect(text).toContain("Add");
  });

  it("sets structurallyChanged when init instructions are removed", () => {
    const dl = tDL(0);
    const tok = tDT(1);
    const dest = tDT(2);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new CallInstruction(tok, DT_STR_SIG, [cStr("v")]),
      new MethodCallInstruction(undefined, dl, "Add", [tok]),
      new MethodCallInstruction(dest, dl, "get_Item", [cInt(0)]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(true);
    expect(result.structurallyChanged).toBe(true);
  });

  it("does not set structurallyChanged when only get_Item is replaced (init kept)", () => {
    const dl = tDL(0);
    const alias = vDL("list");
    const tok = tDT(1);
    const dest = tDT(2);
    const count = tInt(3);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new CallInstruction(tok, DT_STR_SIG, [cStr("item")]),
      new MethodCallInstruction(undefined, dl, "Add", [tok]),
      new AssignmentInstruction(alias, dl),
      new MethodCallInstruction(dest, alias, "get_Item", [cInt(0)]),
      // Residual use keeps init alive
      new PropertyGetInstruction(count, alias, "Count"),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(true);
    expect(result.structurallyChanged).toBeUndefined();
  });

  it("folds multiple elements in a DataList", () => {
    const dl = tDL(0);
    const tok0 = tDT(1);
    const tok1 = tDT(2);
    const tok2 = tDT(3);
    const dest0 = tDT(4);
    const dest1 = tDT(5);
    const dest2 = tDT(6);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new CallInstruction(tok0, DT_STR_SIG, [cStr("first")]),
      new MethodCallInstruction(undefined, dl, "Add", [tok0]),
      new CallInstruction(tok1, DT_STR_SIG, [cStr("second")]),
      new MethodCallInstruction(undefined, dl, "Add", [tok1]),
      new CallInstruction(tok2, DT_STR_SIG, [cStr("third")]),
      new MethodCallInstruction(undefined, dl, "Add", [tok2]),
      new MethodCallInstruction(dest0, dl, "get_Item", [cInt(0)]),
      new MethodCallInstruction(dest1, dl, "get_Item", [cInt(1)]),
      new MethodCallInstruction(dest2, dl, "get_Item", [cInt(2)]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    expect(text).toContain(`${DT_STR_SIG}("first")`);
    expect(text).toContain(`${DT_STR_SIG}("second")`);
    expect(text).toContain(`${DT_STR_SIG}("third")`);
    expect(text).not.toContain("DataList.__ctor__");
    expect(text).not.toContain("get_Item");
  });

  it("folds GetValue + PropertyGet(.String) to direct assignment", () => {
    const dd = tDD(0);
    const kTok = tDT(1);
    const vTok = tDT(2);
    const dtResult = tDT(3);
    const strResult = tStr(4);

    const instructions = [
      new CallInstruction(dd, "DataDictionary.__ctor__", []),
      new CallInstruction(kTok, DT_STR_SIG, [cStr("greeting")]),
      new CallInstruction(vTok, DT_STR_SIG, [cStr("Hello!")]),
      new MethodCallInstruction(undefined, dd, "SetValue", [kTok, vTok]),
      new MethodCallInstruction(dtResult, dd, "GetValue", [kTok]),
      new PropertyGetInstruction(strResult, dtResult, "String"),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    expect(text).toContain('t4 = "Hello!"');
    expect(text).not.toContain("GetValue");
    expect(text).not.toContain(".String");
  });

  it("invalidates DataDictionary when key cannot be resolved in SetValue", () => {
    const dd = tDD(0);
    const unknownKey = tDT(1); // not in dataTokenDefs
    const vTok = tDT(2);
    const dest = tDT(3);
    const hasDest = tBool(4);

    const instructions = [
      new CallInstruction(dd, "DataDictionary.__ctor__", []),
      new CallInstruction(vTok, DT_STR_SIG, [cStr("val")]),
      // unknownKey has no DataToken ctor → candidate invalidated
      new MethodCallInstruction(undefined, dd, "SetValue", [unknownKey, vTok]),
      new MethodCallInstruction(dest, dd, "GetValue", [unknownKey]),
      new MethodCallInstruction(hasDest, dd, "ContainsKey", [unknownKey]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(false);
  });

  it("does not fold get_Item at out-of-range index", () => {
    const dl = tDL(0);
    const tok = tDT(1);
    const dest = tDT(2);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new CallInstruction(tok, DT_STR_SIG, [cStr("only")]),
      new MethodCallInstruction(undefined, dl, "Add", [tok]),
      // Index 5 is not tracked (only index 0 was added)
      new MethodCallInstruction(dest, dl, "get_Item", [cInt(5)]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    // get_Item is not folded (index 5 not in contents)
    // but since no fold occurs, changed should be false
    expect(result.changed).toBe(false);
  });

  it("invalidates on jump that uses the candidate", () => {
    const dl = tDL(0);
    const tok = tDT(1);
    const dest = tDT(2);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new CallInstruction(tok, DT_STR_SIG, [cStr("x")]),
      new MethodCallInstruction(undefined, dl, "Add", [tok]),
      // dl is passed to a conditional jump — invalidate
      new ConditionalJumpInstruction(dl, createLabel("somewhere")),
      new MethodCallInstruction(dest, dl, "get_Item", [cInt(0)]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(false);
  });

  it("invalidates when post-init Temp→Variable alias is later mutated (label-induced phase)", () => {
    const dl = tDL(0);
    const alias1 = vDL("a");
    const alias2 = vDL("b");
    const tok = tDT(1);
    const dest = tDT(2);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new AssignmentInstruction(alias1, dl),
      new CallInstruction(tok, DT_STR_SIG, [cStr("x")]),
      new MethodCallInstruction(undefined, alias1, "Add", [tok]),
      // Non-exposed label transitions alias1's candidate from init → post-init
      label("inner"),
      // Post-init Temp→Variable: alias2 = dl (the original temp t0)
      new AssignmentInstruction(alias2, dl),
      // Mutation via the newly registered alias2 — must invalidate
      new MethodCallInstruction(undefined, alias2, "Add", [tok]),
      new MethodCallInstruction(dest, alias1, "get_Item", [cInt(0)]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(false);
  });

  it("invalidates init-phase candidate when alias is stolen by a second candidate (stale ownership)", () => {
    const dl0 = tDL(0);
    const dl1 = tDL(1);
    const tok = tDT(2);
    const alias = vDL("list");
    const dest = tDT(3);

    const instructions = [
      // dl0 gets the alias first (init phase, alias before adds)
      new CallInstruction(dl0, "DataList.__ctor__", []),
      new AssignmentInstruction(alias, dl0),
      new CallInstruction(tok, DT_STR_SIG, [cStr("from-dl0")]),
      new MethodCallInstruction(undefined, alias, "Add", [tok]),
      // dl1 is created and takes over the same alias variable
      new CallInstruction(dl1, "DataList.__ctor__", []),
      new AssignmentInstruction(alias, dl1), // dl0 must be evicted here
      // get_Item on alias must NOT fold (dl0 evicted; dl1 has no adds)
      new MethodCallInstruction(dest, alias, "get_Item", [cInt(0)]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(false);
  });

  it("invalidates init-phase candidate when its alias is reassigned to a non-candidate value", () => {
    const dl = tDL(0);
    const alias = vDL("list");
    const tok = tDT(1);
    const dest = tDT(2);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new AssignmentInstruction(alias, dl), // alias → dl, stays in init
      new CallInstruction(tok, DT_STR_SIG, [cStr("x")]),
      new MethodCallInstruction(undefined, alias, "Add", [tok]),
      // Reassign alias to a non-candidate (DataToken temp) — must invalidate dl
      new AssignmentInstruction(alias, tok),
      // get_Item via the original temp should NOT fold (candidate invalidated)
      new MethodCallInstruction(dest, dl, "get_Item", [cInt(0)]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(false);
  });

  it("invalidates on transitive alias mutation (alias2 = alias1; alias2.Add() must invalidate)", () => {
    const dl = tDL(0);
    const alias1 = vDL("a");
    const alias2 = vDL("b");
    const tok = tDT(1);
    const dest = tDT(2);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new AssignmentInstruction(alias1, dl),
      new CallInstruction(tok, DT_STR_SIG, [cStr("x")]),
      new MethodCallInstruction(undefined, alias1, "Add", [tok]),
      // Transitive alias: alias2 = alias1 (Variable-to-Variable)
      new AssignmentInstruction(alias2, alias1),
      // Mutation via transitive alias — must invalidate
      new MethodCallInstruction(undefined, alias2, "Add", [tok]),
      new MethodCallInstruction(dest, alias1, "get_Item", [cInt(0)]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(false);
  });

  it("folds get_Item + PropertyGet without leaving a dead DataToken ctor", () => {
    const dl = tDL(0);
    const tok = tDT(1);
    const dtResult = tDT(2);
    const strResult = tStr(3);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new CallInstruction(tok, DT_STR_SIG, [cStr("world")]),
      new MethodCallInstruction(undefined, dl, "Add", [tok]),
      new MethodCallInstruction(dtResult, dl, "get_Item", [cInt(0)]),
      new PropertyGetInstruction(strResult, dtResult, "String"),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    // Fully folded: only the direct assignment remains
    expect(text).toContain('t3 = "world"');
    // Dead DataToken ctor (DataList init path) and the intermediate ctor must be gone
    expect(text).not.toContain("DataList.__ctor__");
    expect(text).not.toContain("Add");
    expect(text).not.toContain(DT_STR_SIG);
  });

  it("DCEs DataToken ctor instructions consumed by a fully folded DataDictionary", () => {
    const dd = tDD(0);
    const kTok = tDT(1);
    const vTok = tDT(2);
    const dtResult = tDT(3);
    const strResult = tStr(4);

    const instructions = [
      new CallInstruction(dd, "DataDictionary.__ctor__", []),
      new CallInstruction(kTok, DT_STR_SIG, [cStr("k")]),
      new CallInstruction(vTok, DT_STR_SIG, [cStr("v")]),
      new MethodCallInstruction(undefined, dd, "SetValue", [kTok, vTok]),
      new MethodCallInstruction(dtResult, dd, "GetValue", [kTok]),
      new PropertyGetInstruction(strResult, dtResult, "String"),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    expect(text).toContain('t4 = "v"');
    // All init (ctor, DataToken ctors, SetValue) must be gone
    expect(text).not.toContain("DataDictionary.__ctor__");
    expect(text).not.toContain("SetValue");
    expect(text).not.toContain(DT_STR_SIG);
  });

  it("invalidates when DataList appears as value in PropertySet (escape through field)", () => {
    const dl = tDL(0);
    const tok = tDT(1);
    const dest = tDT(2);
    const receiver = vDL("container");

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new CallInstruction(tok, DT_STR_SIG, [cStr("x")]),
      new MethodCallInstruction(undefined, dl, "Add", [tok]),
      new AssignmentInstruction(vDL("alias"), dl),
      // DataList appears as the VALUE of a PropertySet — escapes through field
      new PropertySetInstruction(receiver, "Items", vDL("alias")),
      new MethodCallInstruction(dest, vDL("alias"), "get_Item", [cInt(0)]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(false);
  });

  it("invalidates second candidate when it appears as arg in MethodCall whose receiver is a different candidate", () => {
    const dl1 = tDL(0);
    const dl2 = tDL(1);
    const tok1 = tDT(2);
    const tok2 = tDT(3);
    const dest = tDT(4);

    const instructions = [
      new CallInstruction(dl1, "DataList.__ctor__", []),
      new CallInstruction(tok1, DT_STR_SIG, [cStr("a")]),
      new MethodCallInstruction(undefined, dl1, "Add", [tok1]),
      new CallInstruction(dl2, "DataList.__ctor__", []),
      new CallInstruction(tok2, DT_STR_SIG, [cStr("b")]),
      new MethodCallInstruction(undefined, dl2, "Add", [tok2]),
      // dl1 is receiver (candidate), dl2 is arg — dl2 must be invalidated
      new MethodCallInstruction(undefined, dl1, "AddRange", [dl2]),
      // get_Item on dl2 must NOT be folded (dl2 was invalidated)
      new MethodCallInstruction(dest, dl2, "get_Item", [cInt(0)]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(false);
  });

  it("ContainsKey folds to true when SetValue value was a DataList (arg escape, key still tracked)", () => {
    const dd = tDD(0);
    const dl = tDL(1);
    const kTok = tDT(2);
    const hasDest = tBool(3);

    const instructions = [
      new CallInstruction(dd, "DataDictionary.__ctor__", []),
      new CallInstruction(dl, "DataList.__ctor__", []),
      new CallInstruction(kTok, DT_STR_SIG, [cStr("items")]),
      // dl escapes into dd as a value arg → dl invalidated, dd records null value
      new MethodCallInstruction(undefined, dd, "SetValue", [kTok, dl]),
      // ContainsKey should still fold to true — the key is tracked regardless of value
      new MethodCallInstruction(hasDest, dd, "ContainsKey", [kTok]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    expect(text).toContain("true");
    expect(text).not.toContain("ContainsKey");
  });

  it("invalidates DataDictionary via transitive alias mutation", () => {
    const dd = tDD(0);
    const alias1 = createVariable("d1", ddType);
    const alias2 = createVariable("d2", ddType);
    const kTok = tDT(1);
    const vTok = tDT(2);
    const dest = tDT(3);

    const instructions = [
      new CallInstruction(dd, "DataDictionary.__ctor__", []),
      new AssignmentInstruction(alias1, dd),
      new CallInstruction(kTok, DT_STR_SIG, [cStr("k")]),
      new CallInstruction(vTok, DT_STR_SIG, [cStr("v")]),
      new MethodCallInstruction(undefined, alias1, "SetValue", [kTok, vTok]),
      // Transitive alias: alias2 = alias1 (Variable→Variable)
      new AssignmentInstruction(alias2, alias1),
      // Mutation via transitive alias — must invalidate
      new MethodCallInstruction(undefined, alias2, "SetValue", [kTok, vTok]),
      new MethodCallInstruction(dest, alias1, "GetValue", [kTok]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(false);
  });

  it("sets structurallyChanged when only a dead intermediate DataToken ctor is removed (init preserved)", () => {
    const dl = tDL(0);
    const tok = tDT(1);
    const dtResult = tDT(2);
    const strResult = tStr(3);
    const alias = vDL("list");
    const count = tInt(4);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new CallInstruction(tok, DT_STR_SIG, [cStr("hello")]),
      new MethodCallInstruction(undefined, dl, "Add", [tok]),
      new AssignmentInstruction(alias, dl),
      // get_Item + PropertyGet fold: creates a dead intermediate DataToken ctor in result
      new MethodCallInstruction(dtResult, alias, "get_Item", [cInt(0)]),
      new PropertyGetInstruction(strResult, dtResult, "String"),
      // Residual Count use preserves init (no indicesToRemove), but dead ctor is removed
      new PropertyGetInstruction(count, alias, "Count"),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(true);
    // Dead intermediate ctor removed → structurally changed even though init is kept
    expect(result.structurallyChanged).toBe(true);
    const text = stringify(result.instructions);
    expect(text).toContain('t3 = "hello"');
    expect(text).not.toContain("get_Item");
    expect(text).not.toContain(".String");
    // Init preserved due to Count residual use
    expect(text).toContain("DataList.__ctor__");
    expect(text).toContain(".Count");
  });

  it("safe post-init reads (GetKeys, ShallowClone) do not invalidate", () => {
    const dl = tDL(0);
    const tok = tDT(1);
    const dest = tDT(2);
    const alias = vDL("list");
    const cloned = tDL(10);
    const keys = tDL(11);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new CallInstruction(tok, DT_STR_SIG, [cStr("val")]),
      new MethodCallInstruction(undefined, dl, "Add", [tok]),
      new AssignmentInstruction(alias, dl),
      // Safe post-init reads
      new MethodCallInstruction(cloned, alias, "ShallowClone", []),
      new MethodCallInstruction(keys, alias, "GetKeys", []),
      // Still foldable
      new MethodCallInstruction(dest, alias, "get_Item", [cInt(0)]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(true);
    const text = stringify(result.instructions);
    expect(text).not.toContain("get_Item");
    expect(text).toContain("ShallowClone");
    expect(text).toContain("GetKeys");
  });

  it("invalidates when candidate is copied to another temp (ternary-style temp-to-temp)", () => {
    // t1 = t0 where t0 is a DataList candidate: t1 is untracked,
    // so mutations via t1 cannot be caught. Candidate must be invalidated.
    const dl = tDL(0);
    const tok = tDT(1);
    const dl2 = tDL(2); // copy dest — untracked
    const dest = tDT(3);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new CallInstruction(tok, DT_STR_SIG, [cStr("hello")]),
      new MethodCallInstruction(undefined, dl, "Add", [tok]),
      // Temp-to-temp copy: dl2 = dl (e.g. ternary true-branch result)
      new AssignmentInstruction(dl2, dl),
      // Read through original temp — should NOT be folded (candidate invalidated)
      new MethodCallInstruction(dest, dl, "get_Item", [cInt(0)]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(false);
    const text = stringify(result.instructions);
    expect(text).toContain("get_Item");
  });

  it("invalidates post-init candidate on temp-to-temp copy (label-induced post-init)", () => {
    // Candidate is in post-init when the Copy is seen.
    const dl = tDL(0);
    const tok = tDT(1);
    const alias = vDL("list");
    const dl2 = tDL(2);
    const dest = tDT(3);

    const instructions = [
      new CallInstruction(dl, "DataList.__ctor__", []),
      new CallInstruction(tok, DT_STR_SIG, [cStr("world")]),
      new MethodCallInstruction(undefined, dl, "Add", [tok]),
      new AssignmentInstruction(alias, dl), // alias registration → post-init
      label("inner"), // non-exposed label (no-op for phase)
      // Temp-to-temp copy in post-init: dl2 = dl
      new AssignmentInstruction(dl2, dl),
      new MethodCallInstruction(dest, alias, "get_Item", [cInt(0)]),
    ];

    const result = readonlyDataCollectionFolding(instructions);
    expect(result.changed).toBe(false);
    const text = stringify(result.instructions);
    expect(text).toContain("get_Item");
  });
});
