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
