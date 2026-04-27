import { describe, expect, it } from "vitest";
import { TypeMapper } from "../../../src/transpiler/frontend/type_mapper.js";
import {
  ClassTypeSymbol,
  PrimitiveTypes,
} from "../../../src/transpiler/frontend/type_symbols.js";
import { UdonType } from "../../../src/transpiler/frontend/types.js";

describe("TypeMapper", () => {
  describe("lookupBuiltinByName", () => {
    it("maps primitive type names to TypeSymbols", () => {
      const mapper = new TypeMapper();
      expect(mapper.lookupBuiltinByName("string")).toBe(PrimitiveTypes.string);
      expect(mapper.lookupBuiltinByName("number")).toBe(PrimitiveTypes.single);
      expect(mapper.lookupBuiltinByName("boolean")).toBe(
        PrimitiveTypes.boolean,
      );
      expect(mapper.lookupBuiltinByName("void")).toBe(PrimitiveTypes.void);
    });

    it("returns null for unknown names (no text-parsing fallback)", () => {
      const mapper = new TypeMapper();
      expect(mapper.lookupBuiltinByName("MyClass")).toBeNull();
      expect(mapper.lookupBuiltinByName("unknownType123")).toBeNull();
    });
  });

  describe("resolveByBareName", () => {
    it("resolves PascalCase identifiers to ClassTypeSymbol", () => {
      const mapper = new TypeMapper();
      const result = mapper.resolveByBareName("MyClass");
      expect(result).toBeInstanceOf(ClassTypeSymbol);
      expect(result.name).toBe("MyClass");
      expect(result.udonType).toBe(UdonType.Object);
    });

    it("widens unrecognised lowercase identifiers to ObjectType", () => {
      const mapper = new TypeMapper();
      // Replaces the legacy "throws TranspileError" behaviour: callers
      // (the IR `new Foo()` site, the parser `inferType` New branch)
      // would never accept a hard error here, so the bare-name path
      // silently widens instead.
      expect(mapper.resolveByBareName("unknownType123").udonType).toBe(
        UdonType.Object,
      );
    });
  });
});
