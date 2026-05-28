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

function d3DispatchReceiverComparisonLines(
  tac: string,
  receiverName: string,
): string[] {
  const lines = tac.split("\n");
  const comparisons: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/ifFalse \S+ goto d3_method_next/.test(lines[i]?.trim() ?? "")) {
      continue;
    }
    const windowStart = Math.max(0, i - 24);
    const window = lines.slice(windowStart, i + 1);
    comparisons.push(
      ...window.filter((line) =>
        new RegExp(`= ${receiverName} (?:==|>=|<) `).test(line.trim()),
      ),
    );
  }
  return comparisons;
}

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

    // SoA dispatch may use either a concrete __handle equality or a partition
    // range check. It must not compare against compile-time instance ids.
    const comparisons = d3DispatchReceiverComparisonLines(result.tac, "y");
    expect(comparisons.length).toBeGreaterThanOrEqual(2);
    expect(comparisons.some((line) => line.includes("1048577"))).toBe(true);
    expect(comparisons.some((line) => line.includes("2097153"))).toBe(true);
    for (const line of comparisons) {
      expect(line).not.toMatch(/= y == \d+$/);
    }
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
    // branch (unreachable when all instances match).  The regression check is
    // that dispatch branches compare against __handle *variables* (dynamic SoA
    // counter values), not raw integer constants.
    //   Bug form: "tN = tM == 4"                       (constant instId)
    //   Fix form: "tN = tM == __inst_Circle_4__handle" (runtime variable)
    //
    const comparisons = d3DispatchReceiverComparisonLines(result.tac, "shape");
    expect(comparisons.length).toBeGreaterThanOrEqual(2);
    expect(comparisons.some((line) => line.includes("1048577"))).toBe(true);
    expect(comparisons.some((line) => line.includes("2097153"))).toBe(true);
    for (const line of comparisons) {
      expect(line).not.toMatch(/= shape == \d+$/);
    }
  });
});
