import { describe, expect, it } from "vitest";
import { TypeMapper } from "../../../src/transpiler/frontend/type_mapper";
import {
  ArrayTypeSymbol,
  ExternTypes,
  GenericTypeParameterSymbol,
  PrimitiveTypes,
} from "../../../src/transpiler/frontend/type_symbols";

describe("Type symbols", () => {
  it("maps branded numeric types", () => {
    const mapper = new TypeMapper();
    expect(mapper.mapTypeScriptType("UdonByte")).toBe(PrimitiveTypes.byte);
    expect(mapper.mapTypeScriptType("UdonInt")).toBe(PrimitiveTypes.int32);
    expect(mapper.mapTypeScriptType("UdonULong")).toBe(PrimitiveTypes.uint64);
  });

  it("maps Unity/VRChat extern types", () => {
    const mapper = new TypeMapper();
    expect(mapper.mapTypeScriptType("Vector3")).toBe(ExternTypes.vector3);
    expect(mapper.mapTypeScriptType("VRCPlayerApi")).toBe(
      ExternTypes.vrcPlayerApi,
    );
  });

  it("maps array element type", () => {
    const mapper = new TypeMapper();
    const arrayType = mapper.mapTypeScriptType("number[]");
    expect(arrayType).toBeInstanceOf(ArrayTypeSymbol);
    expect((arrayType as ArrayTypeSymbol).elementType).toBe(
      PrimitiveTypes.single,
    );
  });

  it("maps boolean literal types", () => {
    const mapper = new TypeMapper();
    expect(mapper.mapTypeScriptType("true")).toBe(PrimitiveTypes.boolean);
    expect(mapper.mapTypeScriptType("false")).toBe(PrimitiveTypes.boolean);
    expect(mapper.mapTypeScriptType("true | false")).toBe(
      PrimitiveTypes.boolean,
    );
    expect(mapper.mapTypeScriptType("true | false | null")).toBe(
      PrimitiveTypes.boolean,
    );
  });

  it("maps generic placeholder types", () => {
    const mapper = new TypeMapper();
    expect(mapper.mapTypeScriptType("_T")).toBeInstanceOf(
      GenericTypeParameterSymbol,
    );
  });
});
