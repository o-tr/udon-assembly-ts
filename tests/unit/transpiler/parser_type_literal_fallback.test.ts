import { describe, expect, it } from "vitest";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import {
  ExternTypes,
  InterfaceTypeSymbol,
  PrimitiveTypes,
} from "../../../src/transpiler/frontend/type_symbols.js";

describe("parser type-literal text fallback", () => {
  it("maps string-only type literal text to InterfaceTypeSymbol", () => {
    const parser = new TypeScriptParser();
    const mapped = parser.mapTypeWithGenerics(
      "{ value: number; name: string }",
    );

    expect(mapped).toBeInstanceOf(InterfaceTypeSymbol);
    const iface = mapped as InterfaceTypeSymbol;
    expect(iface.properties.get("value")).toBe(PrimitiveTypes.single);
    expect(iface.properties.get("name")).toBe(PrimitiveTypes.string);
  });

  it("maps nested type literal text recursively", () => {
    const parser = new TypeScriptParser();
    const mapped = parser.mapTypeWithGenerics(
      "{ inner: { score: number }; ok: boolean }",
    );

    expect(mapped).toBeInstanceOf(InterfaceTypeSymbol);
    const outer = mapped as InterfaceTypeSymbol;
    const inner = outer.properties.get("inner");
    expect(inner).toBeInstanceOf(InterfaceTypeSymbol);
    expect((inner as InterfaceTypeSymbol).properties.get("score")).toBe(
      PrimitiveTypes.single,
    );
    expect(outer.properties.get("ok")).toBe(PrimitiveTypes.boolean);
  });

  it("falls back to DataDictionary for quoted keys with whitespace", () => {
    const parser = new TypeScriptParser();
    const mapped = parser.mapTypeWithGenerics('{ "display name": string }');

    expect(mapped).toBe(ExternTypes.dataDictionary);
  });

  it("falls back to DataDictionary for quoted keys with parentheses", () => {
    const parser = new TypeScriptParser();
    const mapped = parser.mapTypeWithGenerics('{ "(special)": number }');

    expect(mapped).toBe(ExternTypes.dataDictionary);
  });

  it("falls back to DataDictionary for unsupported index signatures", () => {
    const parser = new TypeScriptParser();
    const mapped = parser.mapTypeWithGenerics("{ [key: string]: number }");
    expect(mapped).toBe(ExternTypes.dataDictionary);
  });
});
