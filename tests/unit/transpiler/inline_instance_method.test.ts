/**
 * Inline instance method call tests
 * Tests for this.field.method() inlining when the field holds an inline class instance.
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

describe("inline instance method calls", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("inlines this.service.method() without EXTERN", () => {
    const source = `
      class Service {
        getValue(): number {
          return 42;
        }
      }
      class Main {
        private service: Service = new Service();
        Start(): void {
          let v: number = this.service.getValue();
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // Should NOT have a method call for getValue in _start
    expect(startSection).not.toMatch(/\.getValue\(/);

    // Should have inlined the constant 42 in _start
    expect(startSection).toContain("42");
  });

  it("propagates return values from inlined methods", () => {
    const source = `
      class Calculator {
        add(a: number, b: number): number {
          return a + b;
        }
      }
      class Main {
        private calc: Calculator = new Calculator();
        Start(): void {
          let result: number = this.calc.add(3, 4);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    // The method should be inlined (no extern for Calculator.add)
    expect(result.tac).not.toContain("EXTERN");
    // Should contain the addition
    expect(result.tac).toContain("+");
  });

  it("inlines this.otherMethod() inside inline class context", () => {
    const source = `
      class Logic {
        helper(): number {
          return 10;
        }
        compute(): number {
          return this.helper();
        }
      }
      class Main {
        private logic: Logic = new Logic();
        Start(): void {
          let v: number = this.logic.compute();
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // In _start, both helper and compute should be inlined
    expect(startSection).not.toMatch(/\.helper\(/);
    expect(startSection).not.toMatch(/\.compute\(/);

    // The inlined value 10 should appear in _start
    expect(startSection).toContain("10");
  });

  it("inlines nested inline instances (this.outer.getInnerVal())", () => {
    const source = `
      class Inner {
        getVal(): number {
          return 99;
        }
      }
      class Outer {
        private inner: Inner = new Inner();
        getInnerVal(): number {
          return this.inner.getVal();
        }
      }
      class Main {
        private outer: Outer = new Outer();
        Start(): void {
          let v: number = this.outer.getInnerVal();
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // In _start, getInnerVal and getVal should be inlined
    expect(startSection).not.toMatch(/\.getInnerVal\(/);
    expect(startSection).not.toMatch(/\.getVal\(/);

    // The constant 99 should appear in _start
    expect(startSection).toContain("99");
  });

  it("processes property initializers in _start (with Start method)", () => {
    const source = `
      class Service {
        val: number = 5;
        getVal(): number {
          return this.val;
        }
      }
      class Main {
        private svc: Service = new Service();
        Start(): void {
          let v: number = this.svc.getVal();
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    // Should have __inst_Service_* variables from property initialization
    expect(result.tac).toContain("__inst_Service_");
    // Property initialization should produce the inline variable for svc
    expect(result.tac).toContain("svc");
  });

  it("processes property initializers in _start (without Start method)", () => {
    const source = `
      class Service {
        val: number = 5;
      }
      class Main {
        private svc: Service = new Service();
        Update(): void {
          let v: number = 1;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    // _start should contain property initialization
    expect(result.tac).toContain("_start");
    // Should have inline instance for Service
    expect(result.tac).toContain("__inst_Service_");
  });

  it("processes constructor body in _start", () => {
    const source = `
      class Main {
        x: number = 0;
        constructor() {
          this.x = 42;
        }
        Start(): void {
          let v: number = this.x;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // Constructor body should set x = 42 in _start
    expect(startSection).toContain("42");
  });

  it("detects recursion and falls back", () => {
    const source = `
      class Recursive {
        recurse(): number {
          return this.recurse();
        }
      }
      class Main {
        private rec: Recursive = new Recursive();
        Start(): void {
          let v: number = this.rec.recurse();
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // The first call is inlined, but the recursive call inside
    // falls back to a method call
    expect(startSection).toMatch(/\.recurse\(/);
  });

  it("inlines multiple instances of the same class", () => {
    const source = `
      class Svc {
        getValue(): number {
          return 1;
        }
      }
      class Main {
        private a: Svc = new Svc();
        private b: Svc = new Svc();
        Start(): void {
          let x: number = this.a.getValue();
          let y: number = this.b.getValue();
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // Both calls should be inlined in _start
    expect(startSection).not.toMatch(/\.getValue\(/);

    // Should have two different inline instance prefixes
    expect(startSection).toContain("__inst_Svc_0");
    expect(startSection).toContain("__inst_Svc_1");
  });

  it("excludes static properties from _start initialization", () => {
    const source = `
      class Main {
        static count: number = 0;
        value: number = 10;
        Start(): void {
          let v: number = this.value;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // Non-static property should be initialized
    expect(startSection).toContain("value");
    // Static property should not appear as a copy target in _start
    expect(startSection).not.toMatch(/^count\s*=/m);
  });

  it("verifies execution order: pendingTopLevelInits → prop init → constructor → Start body", () => {
    const source = `
      const FACTOR = 2 + 3;
      class Main {
        value: number = 10;
        constructor() {
          this.value = 20;
        }
        Start(): void {
          let result: number = this.value;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // After _start, we should see: FACTOR init, then value = 10, then value = 20
    const factorIdx = startSection.indexOf("FACTOR");
    const valueInitIdx = startSection.indexOf("10", factorIdx);
    const ctorIdx = startSection.indexOf("20", valueInitIdx);

    expect(factorIdx).toBeGreaterThan(0);
    expect(valueInitIdx).toBeGreaterThan(factorIdx);
    expect(ctorIdx).toBeGreaterThan(valueInitIdx);
  });

  it("inlines when Start is declared after other methods", () => {
    const source = `
      class Service {
        getValue(): number {
          return 42;
        }
      }
      class Main {
        private service: Service = new Service();
        Update(): void {
          let v: number = this.service.getValue();
        }
        Start(): void {}
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    // Extract the _update section
    const lines = result.tac.split("\n");
    const updateIdx = lines.findIndex((line) => line.includes("_update:"));
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    const updateEnd = lines.findIndex(
      (line, i) => i > updateIdx && line.trim().startsWith("return"),
    );
    const updateSection = lines
      .slice(updateIdx, updateEnd !== -1 ? updateEnd + 1 : undefined)
      .join("\n");

    // getValue should be inlined in Update even though Start is declared after
    expect(updateSection).not.toMatch(/\.getValue\(/);

    // The inlined value 42 should appear
    expect(updateSection).toContain("42");
  });

  it("inlines return this from inline class method", () => {
    const source = `
      class Service {
        getValue(): number { return 42; }
        getSelf(): Service { return this; }
      }
      class Main {
        private svc: Service = new Service();
        Start(): void {
          let s: Service = this.svc.getSelf();
          let v: number = s.getValue();
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // getSelf and getValue should both be inlined
    expect(startSection).not.toMatch(/\.getSelf\(/);
    expect(startSection).not.toMatch(/\.getValue\(/);

    // The constant 42 should appear in _start
    expect(startSection).toContain("42");
  });

  it("passes this as argument from within inline class method", () => {
    const source = `
      class Helper {
        process(svc: Service): number { return svc.getValue(); }
      }
      class Service {
        getValue(): number { return 42; }
        callHelper(h: Helper): number { return h.process(this); }
      }
      class Main {
        private svc: Service = new Service();
        private helper: Helper = new Helper();
        Start(): void {
          let v: number = this.svc.callHelper(this.helper);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // callHelper, process, getValue should all be inlined
    expect(startSection).not.toMatch(/\.callHelper\(/);
    expect(startSection).not.toMatch(/\.process\(/);
    expect(startSection).not.toMatch(/\.getValue\(/);

    // The constant 42 should appear in _start
    expect(startSection).toContain("42");
  });

  it("tracks this alias within inline method scope", () => {
    const source = `
      class Service {
        val: number = 10;
        method(): number {
          let self: Service = this;
          return self.val;
        }
      }
      class Main {
        private svc: Service = new Service();
        Start(): void {
          let v: number = this.svc.method();
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // method should be inlined
    expect(startSection).not.toMatch(/\.method\(/);

    // Should have __inst_Service_ prefix from inlining
    expect(startSection).toContain("__inst_Service_");
  });

  it("rejects entry-point constructor with parameters (Start path)", () => {
    const source = `
      class Main {
        constructor(x: number) {}
        Start(): void {}
      }
    `;
    expect(() => new TypeScriptToUdonTranspiler().transpile(source)).toThrow(
      /constructor must be parameterless/,
    );
  });

  it("rejects entry-point constructor with parameters (no-Start path)", () => {
    const source = `
      class Main {
        constructor(x: number) {}
        Update(): void {}
      }
    `;
    expect(() => new TypeScriptToUdonTranspiler().transpile(source)).toThrow(
      /constructor must be parameterless/,
    );
  });

  it("allows @SerializeField constructor parameter properties in @UdonBehaviour classes", () => {
    const source = `
      import { SerializeField } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonBehaviour";

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        constructor(@SerializeField private value: number) {}
        Start(): void {
          const x = this.value;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    // Should not throw "constructor must be parameterless"
    // The property should be exported in uasm
    expect(result.uasm).toContain("value");
    expect(result.uasm).toContain(".export value");
  });

  it("mixes @SerializeField and regular constructor params correctly in @UdonBehaviour class", () => {
    const source = `
      import { SerializeField } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonBehaviour";

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        constructor(@SerializeField private value: number, extra: string) {}
        Start(): void {}
      }
    `;
    expect(() => new TypeScriptToUdonTranspiler().transpile(source)).toThrow(
      /constructor must be parameterless/,
    );
  });

  it("rejects @SerializeField on constructor params in non-@UdonBehaviour class", () => {
    const source = `
      import { SerializeField } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";

      class Main {
        constructor(@SerializeField private value: number) {}
        Start(): void {}
      }
    `;
    expect(() => new TypeScriptToUdonTranspiler().transpile(source)).toThrow(
      /only allowed in @UdonBehaviour classes/,
    );
  });

  it("rejects @SerializeField on property declarations in non-@UdonBehaviour class", () => {
    const source = `
      import { SerializeField } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";

      class Main {
        @SerializeField
        private value: number = 0;
        Start(): void {}
      }
    `;
    expect(() => new TypeScriptToUdonTranspiler().transpile(source)).toThrow(
      /only allowed in @UdonBehaviour classes/,
    );
  });

  it("@SerializeField param without access modifier is treated as public property", () => {
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { SerializeField } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonBehaviour";

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        constructor(@SerializeField value: number) {
          super();
          this.value = value;
        }
        Start(): void {
          const v = this.value;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    expect(result.uasm).toContain("value");
    expect(result.uasm).toContain(".export value");
  });
});
