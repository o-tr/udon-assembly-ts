import { describe, expect, it } from "vitest";
import {
  DataList,
  dataListCount,
  dataToken,
  getProperty,
  objectEquals,
  runTacProgram,
  UdonVMRuntimeError,
  unwrapDataToken,
} from "../../../src/transpiler/ts_ir/runtime/index.js";

describe("TS IR runtime shim", () => {
  it("throws UdonVMRuntimeError with TAC context for null DataList.Count", () => {
    expect(() =>
      dataListCount(null, { pc: 3, instruction: "count = list.Count" }),
    ).toThrow(UdonVMRuntimeError);

    try {
      dataListCount(null, { pc: 3, instruction: "count = list.Count" });
    } catch (err) {
      expect(err).toBeInstanceOf(UdonVMRuntimeError);
      const runtimeErr = err as UdonVMRuntimeError;
      expect(runtimeErr.pc).toBe(3);
      expect(runtimeErr.instruction).toBe("count = list.Count");
    }
  });

  it("unwraps typed DataToken values and rejects null tokens", () => {
    expect(unwrapDataToken(dataToken(42))).toBe(42);
    expect(() => unwrapDataToken(null, { pc: 7 })).toThrow(UdonVMRuntimeError);
  });

  it("treats undefined and null as equal for TAC loose equality", () => {
    expect(objectEquals(undefined, null)).toBe(true);
    expect(objectEquals(null, undefined)).toBe(true);
    expect(objectEquals(undefined, 0)).toBe(false);
  });

  it("keeps null collection property access loud", () => {
    const list = new DataList([1, 2, 3]);
    expect(getProperty(list, "Count")).toBe(3);
    expect(() => getProperty(null, "Count", { pc: 9 })).toThrow(
      UdonVMRuntimeError,
    );
  });

  it("resolves inline handle fields before falling back to slot defaults", () => {
    const result = runTacProgram(
      [
        ["a", "__inst_Point_1__handle", ["k", 7]],
        ["a", "__inst_Point_1_x", ["k", 42]],
        ["a", "point", ["s", "__inst_Point_1__handle"]],
        ["a", "actual", ["s", "point_x"]],
      ],
      { point_x: "z" },
    );

    expect(result.heap.actual).toBe(42);
  });

  it("resolves TAC temporary tracking aliases through emitted temp slots", () => {
    const result = runTacProgram(
      [
        ["a", "__inst_Result_1__handle", ["k", 3]],
        ["a", "__inst_Result_1_isWin", ["k", true]],
        ["a", "__t12", ["s", "__inst_Result_1__handle"]],
        ["a", "actual", ["s", "__tmp12_isWin"]],
      ],
      { __tmp12_isWin: "f" },
    );

    expect(result.heap.actual).toBe(true);
  });

  it("prefers copied slot field aliases over stale handle fields", () => {
    const result = runTacProgram(
      [
        ["a", "__inst_Result_1__handle", ["k", 3]],
        ["a", "__inst_Result_1_isWin", ["k", false]],
        ["a", "winResult", ["s", "__inst_Result_1__handle"]],
        ["a", "winResult_isWin", ["k", true]],
        ["a", "__t12", ["s", "winResult"]],
        ["a", "actual", ["s", "__tmp12_isWin"]],
      ],
      { __tmp12_isWin: "f" },
    );

    expect(result.heap.actual).toBe(true);
  });

  it("restores inline handle field snapshots when reading DataList items", () => {
    const result = runTacProgram([
      ["call", "list", "VRCSDK3DataDataList.__ctor____VRCSDK3DataDataList", []],
      ["a", "__inst_Item_0__handle", ["k", 1]],
      ["a", "__inst_Item_0_name", ["k", "A"]],
      [
        "call",
        "tokenA",
        "VRCSDK3DataDataToken.__ctor__SystemInt32__VRCSDK3DataDataToken",
        [["s", "__inst_Item_0__handle"]],
      ],
      ["m", null, ["s", "list"], "Add", [["s", "tokenA"]]],
      ["a", "__inst_Item_0_name", ["k", "B"]],
      [
        "call",
        "tokenB",
        "VRCSDK3DataDataToken.__ctor__SystemInt32__VRCSDK3DataDataToken",
        [["s", "__inst_Item_0__handle"]],
      ],
      ["m", null, ["s", "list"], "Add", [["s", "tokenB"]]],
      ["m", "item0", ["s", "list"], "get_Item", [["k", 0]]],
      ["a", "name0", ["s", "__inst_Item_0_name"]],
      ["m", "item1", ["s", "list"], "get_Item", [["k", 1]]],
      ["a", "name1", ["s", "__inst_Item_0_name"]],
    ]);

    expect(result.heap.name0).toBe("A");
    expect(result.heap.name1).toBe("B");
  });
});
