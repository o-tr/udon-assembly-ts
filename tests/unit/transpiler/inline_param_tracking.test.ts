/**
 * Tests for inline instance tracking across method call boundaries.
 *
 * When an inline instance (type alias object literal, inline class, or
 * interface-typed object literal) is passed as a parameter to an inlined
 * method, property access inside that method must resolve to the inline
 * heap variable directly, not emit an EXTERN call.
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

/** Extract a TAC section by label pattern. */
function _getTacSection(tac: string, labelPattern: RegExp): string {
  const lines = tac.split("\n");
  const startIdx = lines.findIndex((line) => labelPattern.test(line));
  if (startIdx < 0) return "";
  const endIdx = lines.findIndex(
    (line, i) => i > startIdx && line.trim().startsWith("return"),
  );
  return lines
    .slice(startIdx, endIdx !== -1 ? endIdx + 1 : undefined)
    .join("\n");
}

describe("inline instance tracking across method boundaries", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("tracks type alias object through inlined static method parameter", () => {
    const source = `
      type Config = { value: number; label: string };
      class Helper {
        static process(cfg: Config): number { return cfg.value; }
      }
      class Entry {
        Start(): void {
          let cfg: Config = { value: 42, label: "test" };
          let r: number = Helper.process(cfg);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // Inline instance variables should be created
    expect(startSection).toMatch(/__inst_Config_\d+_value/);
    expect(startSection).toMatch(/__inst_Config_\d+_label/);

    // Property access inside the inlined method should resolve to
    // inline variables, not EXTERN calls
    expect(startSection).not.toMatch(/EXTERN.*Config/);
  });

  it("tracks inline class instance through inlined instance method parameter", () => {
    const source = `
      class Vec2 {
        x: number = 0;
        y: number = 0;
      }
      class MathHelper {
        static magnitude(v: Vec2): number { return v.x + v.y; }
      }
      class Entry {
        Start(): void {
          let v: Vec2 = new Vec2();
          v.x = 3;
          v.y = 4;
          let m: number = MathHelper.magnitude(v);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // Instance variables should exist
    expect(startSection).toMatch(/__inst_Vec2_\d+_x/);
    expect(startSection).toMatch(/__inst_Vec2_\d+_y/);

    // No EXTERN for Vec2 property access
    expect(startSection).not.toMatch(/EXTERN.*Vec2/);
  });

  it("tracks type alias object through nested inlined method calls", () => {
    const source = `
      type Data = { value: number };
      class Inner {
        static read(d: Data): number { return d.value; }
      }
      class Outer {
        static process(d: Data): number { return Inner.read(d); }
      }
      class Entry {
        Start(): void {
          let d: Data = { value: 99 };
          let r: number = Outer.process(d);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // Instance variable should exist
    expect(startSection).toMatch(/__inst_Data_\d+_value/);

    // No EXTERN for Data property access through nested calls
    expect(startSection).not.toMatch(/EXTERN.*Data/);
  });

  it("resolves properties on interface-typed object literal (classRegistry fallback)", () => {
    const source = `
      interface IConfig {
        value: number;
        name: string;
      }
      class Entry {
        Start(): void {
          let cfg: IConfig = { value: 42, name: "test" };
          let v: number = cfg.value;
          let n: string = cfg.name;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // Inline instance variables should be created for interface properties
    expect(startSection).toMatch(/__inst_IConfig_\d+_value/);
    expect(startSection).toMatch(/__inst_IConfig_\d+_name/);

    // Property access should resolve to inline variables, not EXTERN
    expect(startSection).not.toMatch(/EXTERN.*IConfig/);
  });
});
