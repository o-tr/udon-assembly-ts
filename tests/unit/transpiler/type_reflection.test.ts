import { describe, expect, it } from "vitest";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler";

describe("type reflection data", () => {
  it("emits __refl_typeid and __refl_typename", () => {
    const transpiler = new TypeScriptToUdonTranspiler();
    const source = `
      class Demo {
        Start(): void {}
      }
    `;
    const result = transpiler.transpile(source, {
      optimize: false,
      reflect: true,
    });

    expect(result.uasm).toContain("__refl_typeid");
    expect(result.uasm).toContain("__refl_typename");
    expect(result.uasm).toContain("__refl_typeids");
  });
});
