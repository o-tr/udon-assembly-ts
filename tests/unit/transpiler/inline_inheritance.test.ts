/**
 * Inline inheritance tests
 * Tests that base class property initialization and constructor bodies
 * are correctly inlined for derived inline classes.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

/** Extract the full _start section (up to the next top-level label). */
function getStartSection(tac: string): string {
  const lines = tac.split("\n");
  const startIdx = lines.findIndex((line) => line.includes("_start:"));
  if (startIdx < 0) return "";
  const endIdx = lines.findIndex(
    (line, i) =>
      i > startIdx &&
      /^\w[\w_]*:/.test(line.trim()) &&
      !line.includes("_start:"),
  );
  return lines.slice(startIdx, endIdx !== -1 ? endIdx : undefined).join("\n");
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

    // Both base and derived properties should be initialized with inline instance prefix
    expect(startSection).toMatch(/__inst_Derived_\d+_baseVal\s*=\s*10/);
    expect(startSection).toMatch(/__inst_Derived_\d+_derivedVal\s*=\s*20/);
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

    // Constructor args should be bound and assigned to inline property variables
    expect(startSection).toMatch(/__inst_Derived_\d+_value\s*=\s*/);
    expect(startSection).toMatch(/__inst_Derived_\d+_extra\s*=\s*/);
    // The constant values should appear in the TAC
    expect(startSection).toContain("= 42");
    expect(startSection).toContain("= 99");
    // No dot-access property set — base class property writes must use inline variables
    expect(startSection).not.toMatch(/\.\w+\s*=/);
    // Should not use EXTERN for inline class methods
    expect(result.tac).not.toContain("EXTERN");
  });

  it("runs base constructor writes before derived writes for explicit super()", () => {
    const source = `
      class Base {
        v: number = 0;
        constructor(x: number) {
          this.v = x;
        }
      }
      class Derived extends Base {
        own: number = 2;
        constructor() {
          super(42);
          this.own = 9;
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

    const lines = startSection.split("\n").map((line) => line.trim());
    // Find the second _v = line (first is the initializer, second is the ctor write)
    const vLines = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => line.includes("_v ="));
    const baseWriteIdx = vLines.length >= 2 ? vLines[1].i : -1;
    const derivedInitIdx = lines.findIndex((line) => line.endsWith("_own = 2"));
    const derivedWriteIdx = lines.findIndex((line) =>
      line.endsWith("_own = 9"),
    );

    expect(baseWriteIdx).toBeGreaterThan(-1);
    expect(derivedInitIdx).toBeGreaterThan(-1);
    expect(derivedWriteIdx).toBeGreaterThan(-1);
    expect(baseWriteIdx).toBeLessThan(derivedInitIdx);
    expect(derivedInitIdx).toBeLessThan(derivedWriteIdx);
    expect(startSection).toContain("= 42");
    expect(result.tac).not.toContain("EXTERN");
  });

  it("handles multi-level inheritance (A extends B extends C)", () => {
    const source = `
      class GrandBase {
        grandProp: number = 1;
        constructor(x: number) {
          this.grandProp = x;
        }
      }
      class Middle extends GrandBase {
        midProp: number = 2;
        constructor(x: number, y: number) {
          super(x);
          this.midProp = y;
        }
      }
      class Leaf extends Middle {
        leafProp: number = 3;
        constructor(x: number, y: number, z: number) {
          super(x, y);
          this.leafProp = z;
        }
      }
      class Main {
        Start(): void {
          const leaf = new Leaf(111, 222, 333);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // All three properties should be assigned via constructors
    expect(startSection).toMatch(/__inst_Leaf_\d+_grandProp/);
    expect(startSection).toMatch(/__inst_Leaf_\d+_midProp/);
    expect(startSection).toMatch(/__inst_Leaf_\d+_leafProp/);
    // Constructor arg values should appear
    expect(startSection).toContain("111");
    expect(startSection).toContain("222");
    expect(startSection).toContain("333");
    // No dot-access property set — all writes must use inline variables
    expect(startSection).not.toMatch(/\.\w+\s*=/);
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

    // Base constructor should write to x and y properties on the Derived instance
    expect(startSection).toMatch(/__inst_Derived_\d+_x\s*=/);
    expect(startSection).toMatch(/__inst_Derived_\d+_y\s*=/);
    // The addition v + 1 should be present in the TAC
    expect(startSection).toContain("+ 1");
    // No dot-access property set — all writes must use inline variables
    expect(startSection).not.toMatch(/\.\w+\s*=/);
  });

  it("initializes base properties before derived properties", () => {
    const source = `
      class Base {
        firstProp: number = 100;
      }
      class Derived extends Base {
        secondProp: number = 200;
      }
      class Main {
        Start(): void {
          const d = new Derived();
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // Find the positions of property assignments
    const firstPos = startSection.indexOf("firstProp");
    const secondPos = startSection.indexOf("secondProp");
    expect(firstPos).toBeGreaterThan(-1);
    expect(secondPos).toBeGreaterThan(-1);
    // Base property should be initialized before derived property
    expect(firstPos).toBeLessThan(secondPos);
  });

  it("handles base class without constructor, derived with super()", () => {
    const source = `
      class Base {
        baseField: number = 7;
      }
      class Derived extends Base {
        derivedField: number = 0;
        constructor() {
          super();
          this.derivedField = 14;
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

    // Base property should still be initialized via property initializer
    expect(startSection).toMatch(/__inst_Derived_\d+_baseField\s*=\s*7/);
    // Derived constructor body should execute
    expect(startSection).toMatch(/__inst_Derived_\d+_derivedField\s*=\s*14/);
    expect(result.tac).not.toContain("EXTERN");
  });

  it("for implicit forwarded constructor, inlines super args and orders writes", () => {
    const source = `
      class Base {
        p: number = 0;
        constructor(a: number, b: number) {
          this.p = a + b;
        }
      }
      class Derived extends Base {
        q: number = 5;
      }
      class Main {
        Start(): void {
          const d = new Derived(3, 4);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    const lines = startSection.split("\n").map((line) => line.trim());
    const argAIdx = lines.indexOf("a = 3");
    const argBIdx = lines.indexOf("b = 4");
    const baseCalcIdx = lines.findIndex((line) => /= a \+ b$/.test(line));
    const pLines = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => line.includes("_p ="));
    const baseWriteIdx = pLines.length >= 2 ? pLines[1].i : -1;
    const derivedInitIdx = lines.findIndex((line) => line.endsWith("_q = 5"));

    expect(argAIdx).toBeGreaterThan(-1);
    expect(argBIdx).toBeGreaterThan(-1);
    expect(baseCalcIdx).toBeGreaterThan(-1);
    expect(baseWriteIdx).toBeGreaterThan(-1);
    expect(derivedInitIdx).toBeGreaterThan(-1);
    expect(argAIdx).toBeLessThan(baseCalcIdx);
    expect(argBIdx).toBeLessThan(baseCalcIdx);
    expect(baseCalcIdx).toBeLessThan(derivedInitIdx);
    expect(baseWriteIdx).toBeLessThan(derivedInitIdx);
    expect(startSection).not.toContain("EXTERN");
  });

  it("entry-point inheritance initializes base fields before derived fields", () => {
    const source = `
      class Base {
        baseInit: number = 10;
        baseValue: number = 0;
        constructor(v: number) {
          this.baseValue = v;
        }
      }
      class Main extends Base {
        own: number = 1;
        constructor() {
          super(5);
          this.own = 2;
        }
        Start(): void {}
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);
    const lines = startSection.split("\n").map((line) => line.trim());

    const baseInitIdx = lines.indexOf("baseInit = 10");
    const baseCtorWriteIdx = lines.indexOf("baseValue = v");
    const ownInitIdx = lines.indexOf("own = 1");
    const ownCtorWriteIdx = lines.indexOf("own = 2");

    expect(baseInitIdx).toBeGreaterThan(-1);
    expect(baseCtorWriteIdx).toBeGreaterThan(-1);
    expect(ownInitIdx).toBeGreaterThan(-1);
    expect(ownCtorWriteIdx).toBeGreaterThan(-1);
    expect(baseInitIdx).toBeLessThan(ownInitIdx);
    expect(baseCtorWriteIdx).toBeLessThan(ownInitIdx);
    expect(ownInitIdx).toBeLessThan(ownCtorWriteIdx);
  });

  it("entry-point multi-level inheritance initializes intermediate fields before ctor writes", () => {
    const source = `
      class A {
        a: number = 1;
        constructor(v: number) {
          this.a = v;
        }
      }
      class B extends A {
        b: number = 3;
        constructor(v: number) {
          super(v);
          this.b = 4;
        }
      }
      class Main extends B {
        c: number = 5;
        constructor() {
          super(7);
          this.c = 6;
        }
        Start(): void {}
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);
    const lines = startSection.split("\n").map((line) => line.trim());

    const aLines = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => line.includes("a ="));
    const aInitIdx = aLines.length >= 1 ? aLines[0].i : -1;
    const aWriteIdx = aLines.length >= 2 ? aLines[1].i : -1;
    const bInitIdx = lines.indexOf("b = 3");
    const bWriteIdx = lines.indexOf("b = 4");
    const cInitIdx = lines.indexOf("c = 5");
    const cWriteIdx = lines.indexOf("c = 6");

    expect(aInitIdx).toBeGreaterThan(-1);
    expect(aWriteIdx).toBeGreaterThan(-1);
    expect(bInitIdx).toBeGreaterThan(-1);
    expect(bWriteIdx).toBeGreaterThan(-1);
    expect(cInitIdx).toBeGreaterThan(-1);
    expect(cWriteIdx).toBeGreaterThan(-1);
    expect(aInitIdx).toBeLessThan(aWriteIdx);
    expect(aWriteIdx).toBeLessThan(bInitIdx);
    expect(bInitIdx).toBeLessThan(bWriteIdx);
    expect(bWriteIdx).toBeLessThan(cInitIdx);
    expect(cInitIdx).toBeLessThan(cWriteIdx);
  });

  it("accesses inherited property on derived instance after construction", () => {
    const source = `
      class Base {
        baseVal: number = 0;
        constructor(v: number) {
          this.baseVal = v;
        }
      }
      class Derived extends Base {
        constructor(v: number) {
          super(v);
        }
        getBaseVal(): number {
          return this.baseVal;
        }
      }
      class Main {
        Start(): void {
          const d = new Derived(77);
          let result: number = d.getBaseVal();
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // The method should be inlined and access the same property variable
    expect(startSection).toMatch(/__inst_Derived_\d+_baseVal/);
    expect(result.tac).not.toContain("EXTERN");
  });

  it("creates separate instances for multiple derived objects", () => {
    const source = `
      class Base {
        val: number = 0;
        constructor(v: number) {
          this.val = v;
        }
      }
      class Derived extends Base {
        constructor(v: number) {
          super(v);
        }
      }
      class Main {
        Start(): void {
          const a = new Derived(1);
          const b = new Derived(2);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // Two different instance prefixes should exist
    const instanceMatches = startSection.match(/__inst_Derived_(\d+)_val/g);
    expect(instanceMatches).not.toBeNull();
    const uniquePrefixes = new Set(instanceMatches);
    expect(uniquePrefixes.size).toBeGreaterThanOrEqual(2);
  });
});
