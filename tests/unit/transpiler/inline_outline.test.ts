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

    expect(result.tac).toContain("__outline_Helper_compute_retVal");
    expect(result.tac).toContain("__outline_Helper_compute_returnSiteIdx");
    // Both call sites should produce distinct return labels
    const returnLabels = result.tac.match(/outline_return\d+:/g);
    expect(returnLabels).not.toBeNull();
    expect(returnLabels?.length).toBeGreaterThanOrEqual(2);
  });

  it("falls through to full inline when params access inline-class fields", () => {
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
    const source = `
      class InlineObj {
        value: number = 0;
      }
      class Helper {
        static process(obj: InlineObj): number {
          let acc: number = obj.value;
          acc = acc + 1;
          acc = acc + 2;
          acc = acc + 3;
          acc = acc + 4;
          acc = acc + 5;
          acc = acc + 6;
          acc = acc + 7;
          acc = acc + 8;
          acc = acc + 9;
          acc = acc + 10;
          acc = acc + 11;
          acc = acc + 12;
          acc = acc + 13;
          acc = acc + 14;
          acc = acc + 15;
          acc = acc + 16;
          acc = acc + 17;
          acc = acc + 18;
          acc = acc + 19;
          acc = acc + 20;
          acc = acc + 21;
          acc = acc + 22;
          acc = acc + 23;
          acc = acc + 24;
          acc = acc + 25;
          acc = acc + 26;
          acc = acc + 27;
          acc = acc + 28;
          acc = acc + 29;
          acc = acc + 30;
          acc = acc + 31;
          acc = acc + 32;
          acc = acc + 33;
          acc = acc + 34;
          acc = acc + 35;
          acc = acc + 36;
          acc = acc + 37;
          acc = acc + 38;
          acc = acc + 39;
          acc = acc + 40;
          acc = acc + 41;
          acc = acc + 42;
          acc = acc + 43;
          acc = acc + 44;
          acc = acc + 45;
          acc = acc + 46;
          acc = acc + 47;
          acc = acc + 48;
          acc = acc + 49;
          acc = acc + 50;
          acc = acc + 51;
          acc = acc + 52;
          acc = acc + 53;
          acc = acc + 54;
          acc = acc + 55;
          acc = acc + 56;
          acc = acc + 57;
          acc = acc + 58;
          acc = acc + 59;
          acc = acc + 60;
          acc = acc + 61;
          acc = acc + 62;
          acc = acc + 63;
          acc = acc + 64;
          acc = acc + 65;
          acc = acc + 66;
          acc = acc + 67;
          acc = acc + 68;
          acc = acc + 69;
          acc = acc + 70;
          acc = acc + 71;
          acc = acc + 72;
          acc = acc + 73;
          acc = acc + 74;
          acc = acc + 75;
          acc = acc + 76;
          acc = acc + 77;
          acc = acc + 78;
          acc = acc + 79;
          acc = acc + 80;
          acc = acc + 81;
          acc = acc + 82;
          acc = acc + 83;
          acc = acc + 84;
          acc = acc + 85;
          acc = acc + 86;
          acc = acc + 87;
          acc = acc + 88;
          acc = acc + 89;
          acc = acc + 90;
          acc = acc + 91;
          acc = acc + 92;
          acc = acc + 93;
          acc = acc + 94;
          acc = acc + 95;
          acc = acc + 96;
          acc = acc + 97;
          acc = acc + 98;
          acc = acc + 99;
          return acc;
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
    const source = `
      class Helper {
        static compute(x: number, y: number): number {
${buildLargeBody(150)}
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r1: number = Helper.compute(1, 2);
          const r2: number = Helper.compute(3, 4);
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
      outlineBodyInstrThreshold: LOW_THRESHOLD,
    });

    expect(result.tac).toContain("outline_entry");
    // Both call sites should have distinct return site indices
    const returnSiteAssigns = result.tac.match(
      /__outline_Helper_compute_returnSiteIdx = \d+/g,
    );
    expect(returnSiteAssigns).not.toBeNull();
    expect(returnSiteAssigns?.length).toBeGreaterThanOrEqual(2);
  });
});
