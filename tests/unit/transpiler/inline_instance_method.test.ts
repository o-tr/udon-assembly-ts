/**
 * Inline instance method call tests
 * Tests for this.field.method() inlining when the field holds an inline class instance.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac/index.js";
import {
  TACInstructionKind,
  type TACInstruction,
} from "../../../src/transpiler/ir/tac_instruction";

/** Extract instructions in the _start section (from _start label to its return). */
function getStartSection(tac: TACInstruction[]): TACInstruction[] {
  const startIdx = tac.findIndex(
    (inst) =>
      inst.kind === TACInstructionKind.Label &&
      inst.toString().includes("_start"),
  );
  if (startIdx < 0) return [];
  // Find the Return that ends the _start method
  const endIdx = tac.findIndex(
    (inst, i) => i > startIdx && inst.kind === TACInstructionKind.Return,
  );
  return tac.slice(startIdx, endIdx !== -1 ? endIdx + 1 : undefined);
}

describe("inline instance method calls", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("inlines this.service.method() without EXTERN", () => {
    const parser = new TypeScriptParser();
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
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);
    const startSection = getStartSection(tac);

    // Should NOT have a MethodCallInstruction for getValue in _start
    const hasMethodCall = startSection.some(
      (inst) =>
        inst.kind === TACInstructionKind.MethodCall &&
        inst.toString().includes("getValue"),
    );
    expect(hasMethodCall).toBe(false);

    // Should have inlined the constant 42 in _start
    const tacStr = startSection.map((i) => i.toString()).join("\n");
    expect(tacStr).toContain("42");
  });

  it("propagates return values from inlined methods", () => {
    const transpiler = new TypeScriptToUdonTranspiler();
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
    const result = transpiler.transpile(source);
    // The method should be inlined (no extern for Calculator.add)
    expect(result.tac).not.toContain("EXTERN");
    // Should contain the addition
    expect(result.tac).toContain("+");
  });

  it("inlines this.otherMethod() inside inline class context", () => {
    const parser = new TypeScriptParser();
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
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);
    const startSection = getStartSection(tac);

    // In _start, both helper and compute should be inlined
    const hasMethodCall = startSection.some(
      (inst) =>
        inst.kind === TACInstructionKind.MethodCall &&
        (inst.toString().includes("helper") ||
          inst.toString().includes("compute")),
    );
    expect(hasMethodCall).toBe(false);

    // The inlined value 10 should appear in _start
    const tacStr = startSection.map((i) => i.toString()).join("\n");
    expect(tacStr).toContain("10");
  });

  it("inlines nested inline instances (this.outer.getInnerVal())", () => {
    const parser = new TypeScriptParser();
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
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);
    const startSection = getStartSection(tac);

    // In _start, getInnerVal and getVal should be inlined
    const hasMethodCall = startSection.some(
      (inst) =>
        inst.kind === TACInstructionKind.MethodCall &&
        (inst.toString().includes("getInnerVal") ||
          inst.toString().includes("getVal")),
    );
    expect(hasMethodCall).toBe(false);

    // The constant 99 should appear in _start
    const tacStr = startSection.map((i) => i.toString()).join("\n");
    expect(tacStr).toContain("99");
  });

  it("processes property initializers in _start (with Start method)", () => {
    const parser = new TypeScriptParser();
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
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);
    const tacStr = tac.map((i) => i.toString()).join("\n");

    // Should have __inst_Service_* variables from property initialization
    expect(tacStr).toContain("__inst_Service_");
    // Property initialization should produce the inline variable for svc
    expect(tacStr).toContain("svc");
  });

  it("processes property initializers in _start (without Start method)", () => {
    const parser = new TypeScriptParser();
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
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);
    const tacStr = tac.map((i) => i.toString()).join("\n");

    // _start should contain property initialization
    expect(tacStr).toContain("_start");
    // Should have inline instance for Service
    expect(tacStr).toContain("__inst_Service_");
  });

  it("processes constructor body in _start", () => {
    const parser = new TypeScriptParser();
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
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);
    const startSection = getStartSection(tac);
    const tacStr = startSection.map((i) => i.toString()).join("\n");

    // Constructor body should set x = 42 in _start
    expect(tacStr).toContain("42");
  });

  it("detects recursion and falls back", () => {
    const parser = new TypeScriptParser();
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
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);
    const startSection = getStartSection(tac);

    // The first call is inlined, but the recursive call inside
    // falls back to MethodCallInstruction
    const hasMethodCall = startSection.some(
      (inst) =>
        inst.kind === TACInstructionKind.MethodCall &&
        inst.toString().includes("recurse"),
    );
    expect(hasMethodCall).toBe(true);
  });

  it("inlines multiple instances of the same class", () => {
    const parser = new TypeScriptParser();
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
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);
    const startSection = getStartSection(tac);

    // Both calls should be inlined in _start
    const methodCalls = startSection.filter(
      (inst) =>
        inst.kind === TACInstructionKind.MethodCall &&
        inst.toString().includes("getValue"),
    );
    expect(methodCalls).toHaveLength(0);

    // Should have two different inline instance prefixes
    const tacStr = startSection.map((i) => i.toString()).join("\n");
    expect(tacStr).toContain("__inst_Svc_0");
    expect(tacStr).toContain("__inst_Svc_1");
  });

  it("excludes static properties from _start initialization", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Main {
        static count: number = 0;
        value: number = 10;
        Start(): void {
          let v: number = this.value;
        }
      }
    `;
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);
    const startSection = getStartSection(tac);
    const tacStr = startSection.map((i) => i.toString()).join("\n");

    // Non-static property should be initialized
    expect(tacStr).toContain("value");
    // Static property should not appear as a CopyInstruction target in _start
    const copyInstructions = startSection.filter(
      (inst) =>
        inst.kind === TACInstructionKind.Copy &&
        inst.toString().includes("count"),
    );
    expect(copyInstructions).toHaveLength(0);
  });

  it("verifies execution order: pendingTopLevelInits → prop init → constructor → Start body", () => {
    const parser = new TypeScriptParser();
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
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);
    const startSection = getStartSection(tac);

    // After _start, we should see: FACTOR init, then value = 10, then value = 20
    const afterStart = startSection.map((i) => i.toString());
    const factorIdx = afterStart.findIndex((s) => s.includes("FACTOR"));
    const valueInitIdx = afterStart.findIndex(
      (s, i) => i > factorIdx && s.includes("value") && s.includes("10"),
    );
    const ctorIdx = afterStart.findIndex(
      (s, i) => i > valueInitIdx && s.includes("value") && s.includes("20"),
    );

    expect(factorIdx).toBeGreaterThan(0);
    expect(valueInitIdx).toBeGreaterThan(factorIdx);
    expect(ctorIdx).toBeGreaterThan(valueInitIdx);
  });

  it("inlines when Start is declared after other methods", () => {
    const parser = new TypeScriptParser();
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
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    // Find the _update section (VRC event name for Update)
    const updateIdx = tac.findIndex(
      (inst) =>
        inst.kind === TACInstructionKind.Label &&
        inst.toString().includes("_update"),
    );
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    const updateEnd = tac.findIndex(
      (inst, i) => i > updateIdx && inst.kind === TACInstructionKind.Return,
    );
    const updateSection = tac.slice(updateIdx, updateEnd + 1);

    // getValue should be inlined in Update even though Start is declared after
    const hasMethodCall = updateSection.some(
      (inst) =>
        inst.kind === TACInstructionKind.MethodCall &&
        inst.toString().includes("getValue"),
    );
    expect(hasMethodCall).toBe(false);

    // The inlined value 42 should appear
    const tacStr = updateSection.map((i) => i.toString()).join("\n");
    expect(tacStr).toContain("42");
  });

  it("inlines return this from inline class method", () => {
    const parser = new TypeScriptParser();
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
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);
    const startSection = getStartSection(tac);

    // getSelf and getValue should both be inlined
    const hasMethodCall = startSection.some(
      (inst) =>
        inst.kind === TACInstructionKind.MethodCall &&
        (inst.toString().includes("getSelf") ||
          inst.toString().includes("getValue")),
    );
    expect(hasMethodCall).toBe(false);

    // The constant 42 should appear in _start
    const tacStr = startSection.map((i) => i.toString()).join("\n");
    expect(tacStr).toContain("42");
  });

  it("passes this as argument from within inline class method", () => {
    const parser = new TypeScriptParser();
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
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);
    const startSection = getStartSection(tac);

    // callHelper, process, getValue should all be inlined
    const hasMethodCall = startSection.some(
      (inst) =>
        inst.kind === TACInstructionKind.MethodCall &&
        (inst.toString().includes("callHelper") ||
          inst.toString().includes("process") ||
          inst.toString().includes("getValue")),
    );
    expect(hasMethodCall).toBe(false);

    // The constant 42 should appear in _start
    const tacStr = startSection.map((i) => i.toString()).join("\n");
    expect(tacStr).toContain("42");
  });

  it("tracks this alias within inline method scope", () => {
    const parser = new TypeScriptParser();
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
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);
    const startSection = getStartSection(tac);

    // method should be inlined
    const hasMethodCall = startSection.some(
      (inst) =>
        inst.kind === TACInstructionKind.MethodCall &&
        inst.toString().includes("method"),
    );
    expect(hasMethodCall).toBe(false);

    // Should have __inst_Service_ prefix from inlining
    const tacStr = startSection.map((i) => i.toString()).join("\n");
    expect(tacStr).toContain("__inst_Service_");
  });
});
