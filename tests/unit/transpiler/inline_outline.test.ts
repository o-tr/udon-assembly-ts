/**
 * Tests for the static-method outlining optimisation and inline recursive
 * static method handling.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry.js";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

const LOW_THRESHOLD = 200;

describe("static method outlining", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  /**
   * Helper: build a static method body that emits many TAC instructions.
   * Each `acc = acc + N` emits ~2-3 TAC instructions.
   */
  function buildLargeBody(varCount: number): string {
    const lines: string[] = [];
    lines.push("    let acc: number = 0;");
    for (let i = 0; i < varCount; i++) {
      lines.push(`    acc = acc + ${i};`);
    }
    lines.push("    return acc;");
    return lines.join("\n");
  }

  function buildLargeVoidBody(varCount: number): string {
    const lines: string[] = [];
    lines.push("    let acc: number = 0;");
    for (let i = 0; i < varCount; i++) {
      lines.push(`    acc = acc + ${i};`);
    }
    lines.push("    Debug.Log(acc);");
    return lines.join("\n");
  }

  it("outlines a large static method called from multiple sites", () => {
    // 150 statements × ~2 ix each ≈ 300 instructions → above threshold (200)
    const source = `
      class Helper {
        static compute(): number {
${buildLargeBody(150)}
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r1: number = Helper.compute();
          const r2: number = Helper.compute();
          const r3: number = Helper.compute();
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
      outlineBodyInstrThreshold: LOW_THRESHOLD,
    });

    // The outlined body should have an entry label
    expect(result.tac).toContain("outline_entry");
    // The body should appear only once — check the entry label count
    const entryMatches = result.tac.match(/outline_entry\d*:/g);
    expect(entryMatches).toHaveLength(1);
    // Dispatch and return labels should exist
    expect(result.tac).toContain("outline_dispatch");
    expect(result.tac).toContain("outline_return");
  });

  it("does not emit SystemVoid heap slots for outlined void methods", () => {
    const source = `
      class Helper {
        static touch(): void {
${buildLargeVoidBody(150)}
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          Helper.touch();
          Helper.touch();
          Helper.touch();
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
      outlineBodyInstrThreshold: LOW_THRESHOLD,
    });

    expect(result.tac).toContain("outline_entry");
    expect(result.uasm).not.toMatch(/%SystemVoid/);
  });

  it("does NOT outline a small static method (below threshold)", () => {
    const source = `
      class Helper {
        static add(a: number, b: number): number {
          return a + b;
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r1: number = Helper.add(1, 2);
          const r2: number = Helper.add(3, 4);
          const r3: number = Helper.add(5, 6);
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
      outlineBodyInstrThreshold: LOW_THRESHOLD,
    });

    expect(result.tac).not.toContain("outline_entry");
    expect(result.tac).not.toContain("outline_dispatch");
  });

  it("outlines a large non-recursive method called exactly 2 times", () => {
    const source = `
      class Helper {
        static bigMethod(n: number): number {
${buildLargeBody(150)}
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r1: number = Helper.bigMethod(5);
          const r2: number = Helper.bigMethod(10);
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
      outlineBodyInstrThreshold: LOW_THRESHOLD,
    });

    expect(result.tac).toContain("outline_entry");
  });

  it("uses recursive template (not outline) for self-recursive methods", () => {
    const source = `
      class Helper {
        static factorial(n: number): number {
          if (n <= 1) {
            return 1;
          }
          return n * Helper.factorial(n - 1);
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r1: number = Helper.factorial(5);
          const r2: number = Helper.factorial(10);
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
      outlineBodyInstrThreshold: LOW_THRESHOLD,
    });

    expect(result.tac).not.toContain("outline_entry");
    expect(result.tac).toContain("__inlineRec_");
  });

  it("inlines recursive method with expression statements in body", () => {
    const source = `
      class Helper {
        static factorial(n: number): number {
          Debug.Log(n);
          if (n <= 1) {
            return 1;
          }
          return n * Helper.factorial(n - 1);
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r1: number = Helper.factorial(5);
          const r2: number = Helper.factorial(10);
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
      outlineBodyInstrThreshold: LOW_THRESHOLD,
    });

    expect(result.tac).not.toContain("outline_entry");
    expect(result.tac).toContain("__inlineRec_");
  });

  it("detects self-recursive calls used as expression statements (void return)", () => {
    const bodyLines: string[] = [];
    for (let i = 0; i < 100; i++) {
      bodyLines.push(`          Debug.Log(${i});`);
    }
    const source = `
      class Helper {
        static sideEffectRec(n: number): void {
          if (n <= 0) {
            return;
          }
${bodyLines.join("\n")}
          Helper.sideEffectRec(n - 1);
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          Helper.sideEffectRec(5);
          Helper.sideEffectRec(10);
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
      outlineBodyInstrThreshold: LOW_THRESHOLD,
    });

    expect(result.tac).not.toContain("outline_entry");
    expect(result.tac).toContain("__inlineRec_");
  });

  it("correctly communicates return values through outlined calls", () => {
    const source = `
      class Helper {
        static compute(): number {
${buildLargeBody(150)}
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const a: number = Helper.compute();
          const b: number = Helper.compute();
          Debug.Log(a);
          Debug.Log(b);
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
      outlineBodyInstrThreshold: LOW_THRESHOLD,
    });

    expect(result.tac).toMatch(
      /__outline_static_Helper_compute__h[0-9a-f]+_retVal/,
    );
    expect(result.tac).toMatch(
      /__outline_static_Helper_compute__h[0-9a-f]+_returnSiteIdx/,
    );
    // Both call sites should produce distinct return labels
    const returnLabels = result.tac.match(/outline_return\d+:/g);
    expect(returnLabels).not.toBeNull();
    expect(returnLabels?.length).toBeGreaterThanOrEqual(2);
  });

  it("outlines a large method whose inline-class param is never accessed as a field", () => {
    const source = `
      class InlineObj {
        value: number = 0;
      }
      class Helper {
        static process(obj: InlineObj): number {
${buildLargeBody(150)}
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const o = new InlineObj();
          const r1: number = Helper.process(o);
          const r2: number = Helper.process(o);
          const r3: number = Helper.process(o);
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
      outlineBodyInstrThreshold: LOW_THRESHOLD,
    });

    // The body doesn't actually ACCESS obj.value, but the param IS typed as
    // an inline class. The eligibility check scans the body for param.field
    // accesses. Since the body doesn't use `obj.value`, it should still be
    // outlined.
    // NOTE: the body uses `obj` as a param name but buildLargeBody doesn't
    // reference it, so no field access → outlining is allowed.
    expect(result.tac).toContain("outline_entry");
  });

  it("falls through to full inline when body reads inline-class param field", () => {
    const bodyLines = ["    let acc: number = obj.value;"];
    for (let i = 0; i < 150; i++) {
      bodyLines.push(`    acc = acc + ${i};`);
    }
    bodyLines.push("    return acc;");
    const source = `
      class InlineObj {
        value: number = 0;
      }
      class Helper {
        static process(obj: InlineObj): number {
${bodyLines.join("\n")}
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const o = new InlineObj();
          const r1: number = Helper.process(o);
          const r2: number = Helper.process(o);
          const r3: number = Helper.process(o);
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
      outlineBodyInstrThreshold: LOW_THRESHOLD,
    });

    // Body accesses obj.value → ineligible for outlining
    expect(result.tac).not.toContain("outline_entry");
  });

  it("falls through to full inline when body passes inline-class param to nested inline call", () => {
    const bodyLines = ["    let acc: number = Helper.inner(obj);"];
    for (let i = 0; i < 150; i++) {
      bodyLines.push(`    acc = acc + ${i};`);
    }
    bodyLines.push("    return acc;");
    const source = `
      class InlineObj {
        value: number = 0;
      }
      class Helper {
        static inner(obj: InlineObj): number {
          return obj.value;
        }
        static process(obj: InlineObj): number {
${bodyLines.join("\n")}
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const o = new InlineObj();
          const r1: number = Helper.process(o);
          const r2: number = Helper.process(o);
          const r3: number = Helper.process(o);
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
      outlineBodyInstrThreshold: LOW_THRESHOLD,
    });

    // Body passes obj to a nested inline call → ineligible for outlining
    expect(result.tac).not.toContain("outline_entry");
  });

  it("allows outlining when inline-class param is only passed to a C# extern", () => {
    const bodyLines: string[] = ["    Debug.Log(obj);"];
    for (let i = 0; i < 150; i++) {
      bodyLines.push(`    acc = acc + ${i};`);
    }
    bodyLines.push("    return acc;");
    const source = `
      class InlineObj {
        value: number = 0;
      }
      class Helper {
        static process(obj: InlineObj): number {
          let acc: number = 0;
${bodyLines.join("\n")}
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const o = new InlineObj();
          const r1: number = Helper.process(o);
          const r2: number = Helper.process(o);
          const r3: number = Helper.process(o);
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
      outlineBodyInstrThreshold: LOW_THRESHOLD,
    });

    // Passing inline-class param to Debug.Log (C# extern) is safe
    expect(result.tac).toContain("outline_entry");
  });

  it("does NOT outline a method called only once", () => {
    const source = `
      class Helper {
        static compute(): number {
${buildLargeBody(150)}
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r: number = Helper.compute();
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
      outlineBodyInstrThreshold: LOW_THRESHOLD,
    });

    expect(result.tac).not.toContain("outline_entry");
  });

  it("outlined method with parameters binds args correctly", () => {
    function buildBodyUsingParams(lines: number): string {
      const stmts: string[] = [];
      stmts.push("    let acc: number = x + y;");
      for (let i = 0; i < lines; i++) {
        stmts.push(`    acc = acc + ${i};`);
      }
      stmts.push("    return acc;");
      return stmts.join("\n");
    }

    const source = `
      class Helper {
        static compute(x: number, y: number): number {
${buildBodyUsingParams(150)}
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r1: number = Helper.compute(1, 2);
          const r2: number = Helper.compute(3, 4);
          // Prevent dead-code elimination of r1/r2
          Debug.Log(r1);
          Debug.Log(r2);
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
      outlineBodyInstrThreshold: LOW_THRESHOLD,
    });

    expect(result.tac).toContain("outline_entry");
    // Both call sites bind x and y before the JUMP
    expect(result.tac).toContain("x = 1");
    expect(result.tac).toContain("y = 2");
    expect(result.tac).toContain("x = 3");
    expect(result.tac).toContain("y = 4");
    // Both call sites should have distinct return site indices
    const returnSiteAssigns = result.tac.match(
      /__outline_static_Helper_compute__h[0-9a-f]+_returnSiteIdx = \d+/g,
    );
    expect(returnSiteAssigns).not.toBeNull();
    expect(returnSiteAssigns?.length).toBeGreaterThanOrEqual(2);
  });

  it("outlines an instance method called multiple times on the same receiver", () => {
    const source = `
      class Engine {
        compute(): number {
${buildLargeBody(150)}
        }
        process(): number {
          return this.compute();
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const e = new Engine();
          const r1: number = e.process();
          const r2: number = e.process();
          const r3: number = e.process();
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
      outlineBodyInstrThreshold: LOW_THRESHOLD,
    });

    // Instance method should be outlined via inlineResolvedMethodBody path.
    // Both compute() and process() may be outlined (pass-1 counts both above
    // threshold because inlining expands compute inside each process call).
    expect(result.tac).toContain("outline_entry");
    expect(result.tac).toContain("outline_dispatch");
    expect(result.tac).toMatch(
      /__outline_inst_Engine_process___inst_Engine_0__h[0-9a-f]+_retVal/,
    );
  });

  it("keeps instance recursion on the recursive path while outlining the caller", () => {
    const source = `
      class Engine {
        compute(): number {
          return this.compute();
        }
        process(): number {
${buildLargeBody(150)}
          return this.compute();
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const e = new Engine();
          const r1: number = e.process();
          const r2: number = e.process();
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
      outlineBodyInstrThreshold: LOW_THRESHOLD,
    });

    expect(result.tac).toContain("outline_entry");
    expect(result.tac).toContain("outline_dispatch");
    expect(result.tac).toMatch(
      /__outline_inst_Engine_process___inst_Engine_0__h[0-9a-f]+_retVal/,
    );
  });

  it("falls through to full inline when return type is an inline class", () => {
    const bodyLines: string[] = [];
    bodyLines.push("          const b = new Box();");
    for (let i = 0; i < 150; i++) {
      bodyLines.push(`          b.value = b.value + ${i};`);
    }
    bodyLines.push("          return b;");
    const source = `
      class Box {
        value: number = 1;
      }
      class Helper {
        static make(): Box {
${bodyLines.join("\n")}
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const box = Helper.make();
          const box2 = Helper.make();
          Debug.Log(box.value);
          Debug.Log(box.value + 1);
          Debug.Log(box2.value);
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
      outlineBodyInstrThreshold: LOW_THRESHOLD,
    });

    // Inline-class returns share a single returnVar across call sites,
    // so outlining is ineligible; full inline gives each call site its
    // own inlineInstanceMap entry.
    expect(result.tac).not.toContain("outline_entry");
    expect(result.tac).toContain("__inst_Box_");
  });

  it("outlines a void-return method without corrupting caller flow", () => {
    const source = `
      class Helper {
        static doWork(): void {
          let acc: number = 0;
${Array.from({ length: 150 }, (_, i) => `          acc = acc + ${i};`).join("\n")}
          Debug.Log(acc);
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          Helper.doWork();
          Helper.doWork();
          Debug.Log("after");
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
      outlineBodyInstrThreshold: LOW_THRESHOLD,
    });

    expect(result.tac).toContain("outline_entry");
    // "after" should still be logged — caller flow is not corrupted
    expect(result.tac).toContain('"after"');
  });

  it("handles early return inside outlined body via dispatch table", () => {
    const source = `
      class Helper {
        static clamp(x: number): number {
          if (x < 0) {
            return 0;
          }
${buildLargeBody(150)}
          return x;
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r1: number = Helper.clamp(-5);
          const r2: number = Helper.clamp(10);
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
      outlineBodyInstrThreshold: LOW_THRESHOLD,
    });

    expect(result.tac).toContain("outline_entry");
    expect(result.tac).toContain("outline_dispatch");
  });

  it("keeps static and instance outlines distinct for same method name", () => {
    const source = `
      class Dual {
        static foo(): number {
${buildLargeBody(150)}
          return 1;
        }
        foo(): number {
${buildLargeBody(150)}
          return 2;
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r1: number = Dual.foo();
          const r2: number = Dual.foo();
          const d = new Dual();
          const r3: number = d.foo();
          const r4: number = d.foo();
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
      outlineBodyInstrThreshold: LOW_THRESHOLD,
    });

    expect(result.tac).toContain("outline_entry");
    expect(result.tac).toContain("outline_dispatch");
    // Both static and instance should be outlined — verify distinct keys
    const staticMatches = result.tac.match(
      /__outline_static_Dual_foo__h[0-9a-f]+_retVal/g,
    );
    const instMatches = result.tac.match(
      /__outline_inst_Dual_foo___inst_Dual_\d+__h[0-9a-f]+_retVal/g,
    );
    expect(staticMatches).not.toBeNull();
    expect(instMatches).not.toBeNull();
  });

  it("KNOWN GAP: ternary aliasing of inline-class param is not caught", () => {
    // This test documents that ternary aliasing (cond ? p : other) is NOT
    // detected by hasInlineClassParamDependentUse.  If a future change adds
    // detection for ternary aliasing, this test will fail (outline_entry will
    // disappear) — the fix MUST also ensure outlined bodies handle the aliased
    // variable correctly, not just block outlining.
    const bodyLines = [
      "    const x: InlineObj = n > 0 ? obj : new InlineObj();",
    ];
    for (let i = 0; i < 150; i++) {
      bodyLines.push(`    acc = acc + ${i};`);
    }
    bodyLines.push("    return acc;");
    const source = `
      class InlineObj {
        value: number = 0;
      }
      class Helper {
        static process(n: number, obj: InlineObj): number {
          let acc: number = 0;
${bodyLines.join("\n")}
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const o = new InlineObj();
          const r1: number = Helper.process(1, o);
          const r2: number = Helper.process(2, o);
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
      outlineBodyInstrThreshold: LOW_THRESHOLD,
    });

    // Because ternary aliasing is NOT detected, outlining is allowed even
    // though `obj` is indirectly aliased to `x`.
    expect(result.tac).toContain("outline_entry");
  });

  it("outlines at the default threshold without explicit option", () => {
    const source = `
      class Helper {
        static compute(): number {
${buildLargeBody(150)}
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r1: number = Helper.compute();
          const r2: number = Helper.compute();
          const r3: number = Helper.compute();
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });

    expect(result.tac).toContain("outline_entry");
  });

  it("does NOT outline a small method at the default threshold", () => {
    const source = `
      class Helper {
        static add(a: number, b: number): number {
          return a + b;
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r1: number = Helper.add(1, 2);
          const r2: number = Helper.add(3, 4);
          const r3: number = Helper.add(5, 6);
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });

    expect(result.tac).not.toContain("outline_entry");
  });

  it("single-return-site outline: body end-jump targets return site directly (no dispatch table)", () => {
    // Scenario: outer method Wrapper is large and called twice → outlined in
    // pass 2 (body emitted once).  Inner method (Inner.work) is called from inside
    // Wrapper's body.  In pass 1, Inner.work.callSites is incremented twice
    // (once per Wrapper call), so Inner.work also appears in outlineCandidates.
    // But in pass 2, Wrapper's body is emitted once → Inner.work has only 1
    // return site.  The inline-back fix should patch the body's end-jump to go
    // directly to that return site and not emit a dispatch table.
    const wrapperLines: string[] = [];
    for (let i = 0; i < 80; i++) {
      wrapperLines.push(`          acc = acc + ${i};`);
    }
    const source = `
      class Inner {
        static work(n: number): number {
${buildLargeBody(150)}
        }
      }
      class Wrapper {
        static run(n: number): number {
          let acc: number = 0;
${wrapperLines.join("\n")}
          acc = acc + Inner.work(n);
          return acc;
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r1: number = Wrapper.run(1);
          const r2: number = Wrapper.run(2);
          Debug.Log(r1);
          Debug.Log(r2);
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
      outlineBodyInstrThreshold: LOW_THRESHOLD,
    });

    // No OutlineDispatchInvariant warning should be emitted
    const hasInvariantWarning = (result.diagnostics ?? []).some((d) =>
      d.message.includes("OutlineDispatchInvariant"),
    );
    expect(hasInvariantWarning).toBe(false);

    // Both outer (Wrapper.run) and inner (Inner.work) should be outlined
    const entryLabels = result.tac.match(/outline_entry\d*:/g);
    expect(entryLabels).not.toBeNull();
    expect(entryLabels?.length).toBeGreaterThanOrEqual(2);

    // Inner.work has 1 return site → its dispatch label is patched away.
    // Wrapper.run has 2 return sites → its dispatch label remains.
    // Total dispatch labels in TAC must be exactly 1.
    expect(result.tac.match(/outline_dispatch\d*:/g)?.length ?? 0).toBe(1);
  });
});

describe("inline recursive static method", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("handles inherited recursive static method via derived class", () => {
    const source = `
      class Base {
        static factorial(n: number): number {
          if (n <= 1) {
            return 1;
          }
          return n * Base.factorial(n - 1);
        }
      }
      class Derived extends Base {}
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r: number = Derived.factorial(5);
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });

    expect(result.tac).toContain("__inlineRec_Base_factorial");
    expect(result.tac).toContain("__inlineRec_Base_factorial_selfCallResult_");
    expect(result.tac).toMatch(/goto inline_rec_entry/);
    expect(result.tac).not.toContain("__inlineRec_Derived_factorial");
  });
});

describe("inline recursive instance method", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("dispatches this.method() recursion via JUMP instead of MethodCallInstruction", () => {
    const source = `
      class Counter {
        recurse(n: number): number {
          if (n <= 0) return 0;
          return this.recurse(n - 1) + 1;
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const c: Counter = new Counter();
          const r: number = c.recurse(5);
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });

    expect(result.tac).toContain("__inlineRecInst_Counter_recurse");
    expect(result.tac).toContain(
      "__inlineRecInst_Counter_recurse_selfCallResult_",
    );
    expect(result.tac).toMatch(/goto inline_rec_entry/);
    expect(result.tac).not.toMatch(/Counter\.__recurse_/);
  });

  it("handles class-instance param across recursive frames", () => {
    const source = `
      class Box { x: number = 0; y: number = 0; }
      class StructRec {
        recurse(b: Box, n: number): number {
          if (n <= 0) return b.x + b.y;
          const next: Box = new Box();
          next.x = b.x + 1;
          next.y = b.y + 1;
          return this.recurse(next, n - 1);
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const s: StructRec = new StructRec();
          const start: Box = new Box();
          const r: number = s.recurse(start, 3);
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });

    expect(result.tac).toContain("__inlineRecInst_StructRec_recurse");
    expect(result.tac).toMatch(/goto inline_rec_entry/);
    // No bogus extern lookup for the recursive call.
    expect(result.tac).not.toMatch(/StructRec\.__recurse_/);
  });

  it("emits overflow handler naming the class and method", () => {
    const source = `
      class Loop {
        recurse(n: number): number {
          if (n <= 0) return 0;
          return this.recurse(n - 1);
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const l: Loop = new Loop();
          const r: number = l.recurse(3);
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });

    expect(result.tac).toMatch(
      /Max recursion depth.*exceeded in Loop\.recurse/,
    );
  });

  it("does not corrupt static recursion when both kinds coexist", () => {
    const source = `
      class StaticRec {
        static factorial(n: number): number {
          if (n <= 1) return 1;
          return n * StaticRec.factorial(n - 1);
        }
      }
      class InstRec {
        recurse(n: number): number {
          if (n <= 0) return 0;
          return this.recurse(n - 1) + 1;
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const a: number = StaticRec.factorial(5);
          const r: InstRec = new InstRec();
          const b: number = r.recurse(5);
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });

    // Distinct prefixes prevent stack collision
    expect(result.tac).toContain("__inlineRec_StaticRec_factorial");
    expect(result.tac).toContain("__inlineRecInst_InstRec_recurse");
  });
});
