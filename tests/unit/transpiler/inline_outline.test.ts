/**
 * Tests for the static-method outlining optimisation.
 * When a non-recursive static method is called from enough call sites and
 * its body exceeds the instruction-count threshold, the transpiler emits
 * the body once (with entry/dispatch labels) and generates lightweight
 * JUMP-based call stubs at each call site.
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

  it("preserves inline-instance tracking after outlined inline-class return", () => {
    const source = `
      class Box {
        value: number = 1;
      }
      class Helper {
        static make(): Box {
${buildLargeBody(150)}
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

    expect(result.tac).toContain("outline_entry");
    expect(result.tac).toContain("box.value");
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
});
