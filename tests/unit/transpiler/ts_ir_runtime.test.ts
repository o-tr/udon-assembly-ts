import { describe, expect, it } from "vitest";
import {
  DataList,
  dataListCount,
  dataToken,
  getProperty,
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
});
