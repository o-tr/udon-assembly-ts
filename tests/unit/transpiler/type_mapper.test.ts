import { describe, expect, it } from "vitest";
import { TranspileError } from "../../../src/transpiler/errors/transpile_errors.js";
import { TypeMapper } from "../../../src/transpiler/frontend/type_mapper.js";
import {
  ClassTypeSymbol,
  PrimitiveTypes,
} from "../../../src/transpiler/frontend/type_symbols.js";
import { UdonType } from "../../../src/transpiler/frontend/types.js";

describe("TypeMapper", () => {
  describe("mapTypeScriptType", () => {
    it("maps primitive type names to TypeSymbols", () => {
      const mapper = new TypeMapper();
      expect(mapper.mapTypeScriptType("string")).toBe(PrimitiveTypes.string);
      expect(mapper.mapTypeScriptType("number")).toBe(PrimitiveTypes.single);
      expect(mapper.mapTypeScriptType("boolean")).toBe(PrimitiveTypes.boolean);
      expect(mapper.mapTypeScriptType("void")).toBe(PrimitiveTypes.void);
    });

    it("maps likely user-defined PascalCase names to ClassTypeSymbol", () => {
      const mapper = new TypeMapper();
      const result = mapper.mapTypeScriptType("MyClass");
      expect(result).toBeInstanceOf(ClassTypeSymbol);
      expect(result.name).toBe("MyClass");
      expect(result.udonType).toBe(UdonType.Object);
    });

    it("throws TranspileError for unknown lowercase type names", () => {
      const mapper = new TypeMapper();
      expect(() => mapper.mapTypeScriptType("unknownType123")).toThrow(
        TranspileError,
      );
      expect(() => mapper.mapTypeScriptType("unknownType123")).toThrow(
        /Unknown TypeScript type/,
      );
    });

    it("falls back to ObjectType for unsupported complex type expressions", () => {
      const mapper = new TypeMapper();
      // Complex expressions such as mapped types still fall back to ObjectType
      // without throwing, because they are explicitly recognised as complex.
      expect(mapper.mapTypeScriptType("{ [K: string]: number }").udonType).toBe(
        UdonType.Object,
      );
    });
  });
});
