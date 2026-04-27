import { describe, expect, it } from "vitest";
import { TypeMapper } from "../../../src/transpiler/frontend/type_mapper";
import {
  ExternTypes,
  PrimitiveTypes,
} from "../../../src/transpiler/frontend/type_symbols";

describe("Type symbols", () => {
  it("maps branded numeric types via builtin lookup", () => {
    const mapper = new TypeMapper();
    expect(mapper.lookupBuiltinByName("UdonByte")).toBe(PrimitiveTypes.byte);
    expect(mapper.lookupBuiltinByName("UdonInt")).toBe(PrimitiveTypes.int32);
    expect(mapper.lookupBuiltinByName("UdonULong")).toBe(PrimitiveTypes.uint64);
  });

  it("maps Unity/VRChat extern types via builtin lookup", () => {
    const mapper = new TypeMapper();
    expect(mapper.lookupBuiltinByName("Vector3")).toBe(ExternTypes.vector3);
    expect(mapper.lookupBuiltinByName("VRCPlayerApi")).toBe(
      ExternTypes.vrcPlayerApi,
    );
  });
});
