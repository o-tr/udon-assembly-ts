/**
 * Inline inheritance tests
 * Tests that base class property initialization and constructor bodies
 * are correctly inlined for derived inline classes.
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

describe("inline inheritance", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("initializes base class properties", () => {
    const source = `
      class Base {
        baseVal: number = 10;
      }
      class Derived extends Base {
        derivedVal: number = 20;
      }
      class Main {
        Start(): void {
          const d = new Derived();
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // Both base and derived properties should be initialized
    expect(startSection).toContain("__inst_Derived_");
    expect(startSection).toContain("baseVal");
    expect(startSection).toContain("derivedVal");
    expect(startSection).toContain("10");
    expect(startSection).toContain("20");
  });

  it("executes super() with arguments in derived constructor", () => {
    const source = `
      class Base {
        value: number = 0;
        constructor(v: number) {
          this.value = v;
        }
      }
      class Derived extends Base {
        extra: number = 0;
        constructor(v: number, e: number) {
          super(v);
          this.extra = e;
        }
      }
      class Main {
        Start(): void {
          const d = new Derived(42, 99);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // Both values should be assigned via constructors
    expect(startSection).toContain("42");
    expect(startSection).toContain("99");
    // Should not use EXTERN for inline class methods
    expect(result.tac).not.toContain("EXTERN");
  });

  it("handles multi-level inheritance (A extends B extends C)", () => {
    const source = `
      class GrandBase {
        a: number = 1;
        constructor(x: number) {
          this.a = x;
        }
      }
      class Middle extends GrandBase {
        b: number = 2;
        constructor(x: number, y: number) {
          super(x);
          this.b = y;
        }
      }
      class Leaf extends Middle {
        c: number = 3;
        constructor(x: number, y: number, z: number) {
          super(x, y);
          this.c = z;
        }
      }
      class Main {
        Start(): void {
          const leaf = new Leaf(10, 20, 30);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // All three property initializers and constructor assignments should appear
    expect(startSection).toContain("10");
    expect(startSection).toContain("20");
    expect(startSection).toContain("30");
    // No EXTERN calls for inline classes
    expect(result.tac).not.toContain("EXTERN");
  });

  it("executes base constructor body side effects", () => {
    const source = `
      class Base {
        x: number = 0;
        y: number = 0;
        constructor(v: number) {
          this.x = v;
          this.y = v + 1;
        }
      }
      class Derived extends Base {
        constructor() {
          super(5);
        }
      }
      class Main {
        Start(): void {
          const d = new Derived();
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // Base constructor should compute v + 1 and assign to y
    expect(startSection).toContain("5");
    // The addition v + 1 should be present in the TAC
    expect(startSection).toContain("+");
  });

  it("initializes base properties before derived properties", () => {
    const source = `
      class Base {
        first: number = 100;
      }
      class Derived extends Base {
        second: number = 200;
      }
      class Main {
        Start(): void {
          const d = new Derived();
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // Find the positions of "first" and "second" assignments
    const firstPos = startSection.indexOf("first");
    const secondPos = startSection.indexOf("second");
    expect(firstPos).toBeGreaterThan(-1);
    expect(secondPos).toBeGreaterThan(-1);
    // Base property should be initialized before derived property
    expect(firstPos).toBeLessThan(secondPos);
  });
});
