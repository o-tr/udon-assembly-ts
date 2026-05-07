/**
 * Tests for D3 method dispatch on SoA-forced interface implementors.
 *
 * When concrete classes implementing an interface are constructed inside a loop,
 * they are promoted to SoA storage mode. Their runtime handle is a dynamic SoA
 * counter value, not the compile-time instanceId. The interface dispatch must use
 * a variable comparison (`__handle` var) rather than a constant (instId), or every
 * dispatch will miss at runtime.
 *
 * Regression for: useInterfaceInstanceIdDispatch + SoA classes → constant handle
 * mismatch at runtime → "D3 method dispatch miss" on every call.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry.js";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

describe("SoA interface dispatch", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("does not emit dispatch-miss path when SoA implementors are dispatched via interface", () => {
    // The preamble loop forces TanyaoYaku and PinfuYaku into SoA mode.
    // Registry.get() returns IYaku (type alias), so calling y.check() goes
    // through the D3 method dispatch path using useInterfaceInstanceIdDispatch.
    // Without the fix, that path uses createConstant(instId) for handle
    // comparison — which always misses at runtime because SoA handles are
    // dynamic counter values, not sequential instanceIds.
    const source = `
      type IYaku = { check(): boolean };

      class TanyaoYaku implements IYaku {
        check(): boolean { return true; }
      }
      class PinfuYaku implements IYaku {
        check(): boolean { return false; }
      }
      class Registry {
        private yaku: Map<string, IYaku> = new Map();
        constructor() {
          const t = new TanyaoYaku();
          const p = new PinfuYaku();
          this.yaku.set("Tanyao", t);
          this.yaku.set("Pinfu", p);
        }
        get(name: string): IYaku | null {
          return this.yaku.get(name) ?? null;
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          // preamble loop forces Registry (and its ctor-created instances) into SoA
          for (let i = 0; i < 1; i++) {
            const _warm = new Registry();
          }
          const reg = new Registry();
          const y: IYaku | null = reg.get("Tanyao");
          // Method call on IYaku — goes through D3 method dispatch path
          const ok: boolean = y !== null ? y.check() : false;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    // The dispatch comparison must use __handle variables, not constant instIds.
    // Bug form: "tN = tM == 5"  (sequential compile-time instanceId, never
    //           matches the per-class SoA counter at runtime → dispatch miss).
    // Fix form: "tN = tM == __inst_TanyaoYaku_K__handle"  (runtime variable).
    expect(result.tac).toContain("== __inst_TanyaoYaku_");
    expect(result.tac).toContain("== __inst_PinfuYaku_");
  });

  it("uses __handle variable (not constant) for SoA implementors in multi-instance dispatch", () => {
    // Registry.pick() returns IShape — the return value is untracked (interface-
    // typed), so calling result.area() must go through multi-branch D3 dispatch.
    // Both Circle and Square become SoA because they're constructed inside a loop
    // (the preamble loop forces Registry ctor into SoA, and its ctor creates
    // Circle/Square).  Without the fix the dispatch would use createConstant(instId)
    // for handle comparison, which never matches the dynamic SoA counter value.
    const source = `
      interface IShape {
        area(): number;
      }
      class Circle implements IShape {
        private r: number = 1;
        area(): number { return this.r; }
      }
      class Square implements IShape {
        private s: number = 2;
        area(): number { return this.s; }
      }
      class ShapeRegistry {
        private c: Circle = new Circle();
        private s: Square = new Square();
        pick(which: number): IShape {
          if (which === 0) return this.c;
          return this.s;
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          // Loop forces ShapeRegistry (and its Circle/Square) into SoA
          for (let i = 0; i < 1; i++) {
            const _r = new ShapeRegistry();
          }
          const reg = new ShapeRegistry();
          // pick() returns IShape — untracked, triggers multi-branch D3 dispatch
          const shape: IShape = reg.pick(0);
          const result: number = shape.area();
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    // The D3 dispatch miss fallback is always emitted in the TAC as the last
    // branch (it's unreachable when all instances match).  The real regression
    // check is that dispatch branches compare against __handle *variables*
    // (dynamic SoA counter values), not against raw integer constants.
    // With the bug, SoA dispatch would emit  "t = x == 4"  (constant instId).
    // With the fix, it emits               "t = x == __inst_Circle_4__handle".
    // Dispatch comparison lines: "tN = tM == __inst_ClassName_K__handle"
    const d3BranchLines = result.tac
      .split("\n")
      .filter((l) => l.includes("== __inst_") && l.includes("__handle"));

    // There must be at least two dispatch comparison branches (Circle + Square)
    expect(d3BranchLines.length).toBeGreaterThanOrEqual(2);

    // No D3 dispatch branch should compare against a bare integer constant.
    // Broken form: "tN = tM == 4" (constant instId). Fixed form uses __handle.
    // Filter to D3 dispatch comparison lines only (contain "== __inst_" or are
    // adjacent to d3_method labels) to avoid catching unrelated constant
    // comparisons from inlined pick(which === 0) bodies.
    const badD3Comparisons = d3BranchLines.filter((l) =>
      /== \d+$/.test(l.trim()),
    );
    expect(badD3Comparisons).toHaveLength(0);
  });
});
