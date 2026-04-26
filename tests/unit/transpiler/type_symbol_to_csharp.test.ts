import { describe, expect, it } from "vitest";
import {
  ArrayTypeSymbol,
  ClassTypeSymbol,
  CollectionTypeSymbol,
  ExternTypes,
  GenericTypeParameterSymbol,
  InterfaceTypeSymbol,
  NativeArrayTypeSymbol,
  ObjectType,
  PrimitiveTypes,
  typeSymbolToCSharp,
} from "../../../src/transpiler/frontend/type_symbols.js";
import { UdonType } from "../../../src/transpiler/frontend/types.js";

describe("typeSymbolToCSharp", () => {
  it("maps primitive TypeSymbols to System.* FQNs", () => {
    expect(typeSymbolToCSharp(PrimitiveTypes.string)).toBe("System.String");
    expect(typeSymbolToCSharp(PrimitiveTypes.int32)).toBe("System.Int32");
    expect(typeSymbolToCSharp(PrimitiveTypes.single)).toBe("System.Single");
    expect(typeSymbolToCSharp(PrimitiveTypes.boolean)).toBe("System.Boolean");
    expect(typeSymbolToCSharp(PrimitiveTypes.double)).toBe("System.Double");
    expect(typeSymbolToCSharp(PrimitiveTypes.byte)).toBe("System.Byte");
    expect(typeSymbolToCSharp(PrimitiveTypes.int64)).toBe("System.Int64");
  });

  it("maps Unity ExternTypeSymbols to UnityEngine.* FQNs", () => {
    expect(typeSymbolToCSharp(ExternTypes.vector3)).toBe("UnityEngine.Vector3");
    expect(typeSymbolToCSharp(ExternTypes.transform)).toBe(
      "UnityEngine.Transform",
    );
    expect(typeSymbolToCSharp(ExternTypes.gameObject)).toBe(
      "UnityEngine.GameObject",
    );
  });

  it("maps VRC ExternTypeSymbols to VRC.* FQNs", () => {
    expect(typeSymbolToCSharp(ExternTypes.vrcPlayerApi)).toBe(
      "VRC.SDKBase.VRCPlayerApi",
    );
    expect(typeSymbolToCSharp(ExternTypes.dataList)).toBe(
      "VRC.SDK3.Data.DataList",
    );
    expect(typeSymbolToCSharp(ExternTypes.dataToken)).toBe(
      "VRC.SDK3.Data.DataToken",
    );
  });

  it("maps the canonical ObjectType to System.Object", () => {
    expect(typeSymbolToCSharp(ObjectType)).toBe("System.Object");
  });

  it("recursively expands ArrayTypeSymbol with [] suffix", () => {
    const intArray = new ArrayTypeSymbol(PrimitiveTypes.int32);
    expect(typeSymbolToCSharp(intArray)).toBe("System.Int32[]");

    const vectorArray = new ArrayTypeSymbol(ExternTypes.vector3);
    expect(typeSymbolToCSharp(vectorArray)).toBe("UnityEngine.Vector3[]");
  });

  it("expands multi-dimensional ArrayTypeSymbol with [][] per dimension", () => {
    const intArray2D = new ArrayTypeSymbol(PrimitiveTypes.int32, 2);
    expect(typeSymbolToCSharp(intArray2D)).toBe("System.Int32[][]");

    const intArray3D = new ArrayTypeSymbol(PrimitiveTypes.int32, 3);
    expect(typeSymbolToCSharp(intArray3D)).toBe("System.Int32[][][]");
  });

  it("expands NativeArrayTypeSymbol to elementFQN[] (not the SystemFooArray name)", () => {
    const singleArray = new NativeArrayTypeSymbol(PrimitiveTypes.single);
    expect(typeSymbolToCSharp(singleArray)).toBe("System.Single[]");

    const int32Array = new NativeArrayTypeSymbol(PrimitiveTypes.int32);
    expect(typeSymbolToCSharp(int32Array)).toBe("System.Int32[]");

    const stringArray = new NativeArrayTypeSymbol(PrimitiveTypes.string);
    expect(typeSymbolToCSharp(stringArray)).toBe("System.String[]");
  });

  it("falls back to symbol.name for user ClassTypeSymbol with UdonType.Object", () => {
    const userClass = new ClassTypeSymbol("MyClass", UdonType.Object);
    expect(typeSymbolToCSharp(userClass)).toBe("MyClass");
  });

  it("falls back to symbol.name for InterfaceTypeSymbol", () => {
    const iface = new InterfaceTypeSymbol("IFoo");
    expect(typeSymbolToCSharp(iface)).toBe("IFoo");
  });

  it("falls back to symbol.name for GenericTypeParameterSymbol", () => {
    const generic = new GenericTypeParameterSymbol("T");
    expect(typeSymbolToCSharp(generic)).toBe("T");
  });

  it("falls back to symbol.name for non-Data CollectionTypeSymbol (UdonType.Object)", () => {
    const mapType = new CollectionTypeSymbol(
      "Map",
      undefined,
      PrimitiveTypes.string,
      PrimitiveTypes.int32,
    );
    expect(typeSymbolToCSharp(mapType)).toBe("Map");
  });

  it("maps DataList CollectionTypeSymbol to VRC FQN (UdonType.DataList branch)", () => {
    const dataList = new CollectionTypeSymbol("DataList", PrimitiveTypes.int32);
    expect(typeSymbolToCSharp(dataList)).toBe("VRC.SDK3.Data.DataList");
  });
});
