import { describe, expect, it } from "vitest";
import {
  DataList,
  dataListCount,
  dataToken,
  getProperty,
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
});
