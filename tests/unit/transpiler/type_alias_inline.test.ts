/**
 * Tests for type alias object literal → inline heap variable generation.
 *
 * When a variable is declared with a type alias that maps to an
 * InterfaceTypeSymbol (e.g. `type Ctx = { count: number }`), the
 * object literal initializer must be lowered to inline heap variables
 * (like regular inline class instances) instead of a DataDictionary.
 * Property access on those instances must resolve to the heap variable
 * directly, not emit an EXTERN call.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

/** Extract lines in the _start section (from _start label to its return). */
function getStartSection(tac: string): string {
  const lines = tac.split("\n");
  const startIdx = lines.findIndex((line) => line.includes("_start:"));
  if (startIdx < 0) return "";
  const endIdx = lines.findIndex(
    (line, i) => i > startIdx && line.trim().startsWith("return"),
  );
  return lines
    .slice(startIdx, endIdx !== -1 ? endIdx + 1 : undefined)
    .join("\n");
}

describe("type alias inline heap variables", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("lowers type alias object literal to inline heap variables", () => {
    const source = `
      type Ctx = { count: number };
      class Main {
        Start(): void {
          let ctx: Ctx = { count: 10 };
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // Should create inline instance variables with __inst_Ctx_ prefix
    expect(startSection).toMatch(/__inst_Ctx_\d+_count/);

    // Should NOT generate a PropertyGetInstruction or EXTERN for Ctx
    expect(result.tac).not.toMatch(/PropertyGet.*Ctx/);
    expect(result.uasm).not.toContain("Ctx.__get_");
  });

  it("resolves property access on type alias instance via inline variable", () => {
    const source = `
      type Ctx = { count: number };
      class Main {
        Start(): void {
          let ctx: Ctx = { count: 42 };
          let v: number = ctx.count;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // Property access should resolve to a CopyInstruction referencing
    // the inline heap variable, not an EXTERN call
    expect(result.uasm).not.toContain("EXTERN");
    expect(startSection).toMatch(/__inst_Ctx_\d+_count/);
  });

  it("handles multiple properties in type alias", () => {
    const source = `
      type Point = { x: number; y: number };
      class Main {
        Start(): void {
          let p: Point = { x: 1, y: 2 };
          let a: number = p.x;
          let b: number = p.y;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // Both properties should be inline heap variables
    expect(startSection).toMatch(/__inst_Point_\d+_x/);
    expect(startSection).toMatch(/__inst_Point_\d+_y/);

    // No EXTERN for Point property access
    expect(result.uasm).not.toContain("Point.__get_");
  });

  it("supports type alias with mixed property types", () => {
    const source = `
      type Config = { name: string; value: number; active: boolean };
      class Main {
        Start(): void {
          let cfg: Config = { name: "test", value: 100, active: true };
          let n: string = cfg.name;
          let v: number = cfg.value;
          let a: boolean = cfg.active;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    // Property accesses should resolve without EXTERN getters
    expect(result.uasm).not.toContain("Config.__get_");
  });

  it("tracks inline instance assignment propagation", () => {
    const source = `
      type Ctx = { count: number };
      class Main {
        Start(): void {
          let ctx: Ctx = { count: 5 };
          let alias: Ctx = ctx;
          let v: number = alias.count;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    // Alias assignment should propagate the inline instance mapping
    // so alias.count also resolves without EXTERN
    expect(result.uasm).not.toContain("EXTERN");
    expect(result.tac).toMatch(/__inst_Ctx_\d+_count/);
  });

  it("falls back to DataDictionary when spread is present", () => {
    const source = `
      type Ctx = { count: number };
      class Main {
        Start(): void {
          let other: object = {};
          let ctx: Ctx = { ...other, count: 10 };
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    // Spread prevents inline path — should NOT create inline instance variables
    expect(result.tac).not.toMatch(/__inst_Ctx_\d+_count/);
  });

  it("falls back to DataDictionary for empty type alias", () => {
    const source = `
      type Empty = {};
      class Main {
        Start(): void {
          let e: Empty = {};
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    // Empty interface (properties.size === 0) should not use inline path
    expect(result.tac).not.toMatch(/__inst_Empty_/);
  });

  it("inlines re-assigned type alias object literal", () => {
    const source = `
      type Ctx = { count: number };
      class Main {
        Start(): void {
          let ctx: Ctx = { count: 5 };
          ctx = { count: 20 };
          let v: number = ctx.count;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    // Re-assignment should also use inline path
    // Two inline instances should be created (one per object literal)
    const matches = result.tac.match(/__inst_Ctx_\d+_count/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);

    // Property access should resolve without EXTERN
    expect(result.uasm).not.toContain("EXTERN");
  });

  it("inlines nested typed object literals", () => {
    const source = `
      type Inner = { x: number };
      type Outer = { inner: Inner };
      class Main {
        Start(): void {
          let o: Outer = { inner: { x: 5 } };
          let v: number = o.inner.x;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    // Both Outer and Inner should be inlined
    expect(result.tac).toMatch(/__inst_Outer_\d+_inner/);
    expect(result.tac).toMatch(/__inst_Inner_\d+_x/);

    // No EXTERN for property access
    expect(result.uasm).not.toContain("EXTERN");
  });

  it("inlines object literal argument passed to inline class method", () => {
    const source = `
      type Config = { value: number; label: string };
      class Analyzer {
        process(cfg: Config): number { return cfg.value; }
      }
      class Entry {
        private analyzer: Analyzer = new Analyzer();
        Start(): void {
          this.analyzer.process({ value: 42, label: "test" });
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // The object literal should be inlined as heap variables
    expect(startSection).toMatch(/__inst_Config_\d+_value/);
    expect(startSection).toMatch(/__inst_Config_\d+_label/);

    // In the _start section (inline expansion), property access should resolve
    // to inline variables, not PropertyGet/EXTERN
    expect(startSection).not.toMatch(/PropertyGet.*Config/);
    expect(startSection).not.toMatch(/EXTERN.*Config/);
  });

  it("inlines object literal argument in entry-point self-method call", () => {
    const source = `
      type Config = { value: number };
      class Entry {
        process(cfg: Config): number { return cfg.value; }
        Start(): void {
          this.process({ value: 42 });
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // The object literal should be inlined as heap variables
    expect(startSection).toMatch(/__inst_Config_\d+_value/);

    // Property access inside the inlined method body should resolve
    // to the inline variable, not PropertyGet/EXTERN
    expect(startSection).not.toMatch(/PropertyGet.*Config/);
    expect(startSection).not.toMatch(/EXTERN.*Config/);
  });
});
