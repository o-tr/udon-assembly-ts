/**
 * Tests for inline returns that should preserve structural object types.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";
import { getStartSection } from "./test_helpers.js";

describe("inline erased return handling", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("keeps a named union of structs inline", () => {
    const source = `
      type WinResultWin = { isWin: true; a: number };
      type WinResultNotWin = { isWin: false; b: string };
      type WinResult = WinResultWin | WinResultNotWin;

      class HandAnalyzer {
        selectBestWin(flag: boolean): WinResult {
          return flag
            ? { isWin: true, a: 1 }
            : { isWin: false, b: "x" };
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        private analyzer: HandAnalyzer = new HandAnalyzer();
        Start(): void {
          const result = this.analyzer.selectBestWin(true);
          const a = result.a;
          const isWin = result.isWin;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);
    const erased = result.diagnostics?.find(
      (diagnostic) => diagnostic.code === "ErasedReturnInline",
    );

    expect(erased).toBeUndefined();
    expect(startSection).not.toContain("DataToken");
  });

  it("keeps an anonymous nullable object union inline", () => {
    const source = `
      class HandAnalyzer {
        evaluate(flag: boolean): { x: number } | null {
          return flag ? { x: 1 } : null;
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        private analyzer: HandAnalyzer = new HandAnalyzer();
        Start(): void {
          const x = this.analyzer.evaluate(true)!.x;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);
    const erased = result.diagnostics?.find(
      (diagnostic) => diagnostic.code === "ErasedReturnInline",
    );

    expect(erased).toBeUndefined();
    expect(startSection).not.toContain("DataToken");
  });

  it("resolves unions with structurally identical nested anonymous struct properties", () => {
    const source = `
      type Left = { point: { x: number }; tag: number };
      type Right = { point: { x: number }; tag: number };
      type Either = Left | Right;

      class HandAnalyzer {
        pick(flag: boolean): Either {
          return flag
            ? { point: { x: 1 }, tag: 1 }
            : { point: { x: 2 }, tag: 2 };
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        private analyzer: HandAnalyzer = new HandAnalyzer();
        Start(): void {
          const r = this.analyzer.pick(true);
          const t = r.tag;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const erased = result.diagnostics?.find(
      (diagnostic) => diagnostic.code === "ErasedReturnInline",
    );

    expect(erased).toBeUndefined();
    expect(result.tac).not.toContain("DataToken");
  });

  it("propagates structural union field copies across nested inline returns", () => {
    // Mirrors pr170_union_with_array_field VM fixture. The leading ternary
    // return `return cond ? a : b` was the trigger: at TAC generation time
    // it hits the plain-copy fallback in visitReturnStatement (no valueMapping
    // for the ternary temp), which would historically set
    // returnTrackingInvalidated=true and poison subsequent tracked returns.
    const source = `
      type Win = { tag: true; value: number; list: string[] };
      type Loss = { tag: false };
      type Result = Win | Loss;

      class M {
        private selectBest(a: Result, b: Result): Result {
          if (a.tag && b.tag) {
            return (a.value as number) >= (b.value as number) ? a : b;
          }
          if (a.tag) return a;
          if (b.tag) return b;
          return { tag: false };
        }
        compute(v: number): Result {
          const win: Win = { tag: true, value: v, list: ["alpha", "beta"] };
          return this.selectBest(win, { tag: false });
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r = new M().compute(11);
          const t = r.tag;
          const lst = r.tag ? r.list.length : 0;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const tagMatch = result.tac.match(
      /(__inline_ret_(\d+))_tag = (__inline_ret_(\d+))_tag/,
    );
    expect(tagMatch).not.toBeNull();
    expect(tagMatch?.[2]).not.toBe(tagMatch?.[4]);
    const listMatch = result.tac.match(
      /(__inline_ret_(\d+))_list = (__inline_ret_(\d+))_list/,
    );
    expect(listMatch).not.toBeNull();
    expect(listMatch?.[2]).not.toBe(listMatch?.[4]);
    expect(result.tac).not.toMatch(/uninst_prop.*__inst_Win_/);
  });

  it("propagates union field copies across nested inline returns with null-typed param", () => {
    const source = `
      type Win = { tag: true; value: number };
      type Loss = { tag: false };
      type Result = Win | Loss;

      class M {
        private selectBest(a: Result | null, b: Result | null): Result {
          if (a !== null && a.tag && b !== null && b.tag) {
            return (a.value as number) >= (b.value as number) ? a : b;
          }
          if (a !== null && a.tag) return a;
          if (b !== null && b.tag) return b;
          return { tag: false };
        }
        run(v: number): Result {
          const win: Win = { tag: true, value: v };
          return this.selectBest(win, null);
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r = new M().run(9);
          const t = r.tag;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const tagMatch = result.tac.match(
      /(__inline_ret_(\d+))_tag = (__inline_ret_(\d+))_tag/,
    );
    expect(tagMatch).not.toBeNull();
    expect(tagMatch?.[2]).not.toBe(tagMatch?.[4]);
    expect(result.tac).not.toMatch(/uninst_prop.*__inst_Win_/);
  });

  it("single-level union return emits only one outer field-copy chain", () => {
    const source = `
      type A = { tag: true; x: number };
      type B = { tag: false };
      type E = A | B;

      class H {
        pick(f: boolean): E {
          return f ? { tag: true, x: 1 } : { tag: false };
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r = new H().pick(true);
          const t = r.tag;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const outerCopies = new Set(
      [
        ...result.tac.matchAll(
          /(__inline_ret_\d+)_tag = __inline_ret_\d+_tag/g,
        ),
      ].map((m) => m[1]),
    );
    expect(outerCopies.size).toBeLessThanOrEqual(1);
  });

  it("still erases incompatible primitive unions", () => {
    const source = `
      class HandAnalyzer {
        pick(value: string | number): string | number {
          return value as any;
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        private analyzer: HandAnalyzer = new HandAnalyzer();
        Start(): void {
          const result = this.analyzer.pick("x");
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const erased = result.diagnostics?.find(
      (diagnostic) => diagnostic.code === "ErasedReturnInline",
    );

    expect(erased).toBeDefined();
    expect(result.tac).toContain("DataToken");
  });
});
