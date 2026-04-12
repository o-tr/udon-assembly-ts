/**
 * Regression tests for optimizer bugs and missing optimizations discovered
 * via UASM comparison between UdonSharp (C#) and udon-assembly-ts.
 *
 * Each test is tagged with the category:
 *   [BUG]     — optimizer crashes or produces incorrect output
 *   [REGRESS] — optimization makes output worse than baseline (no optimization)
 *   [GAP]     — optimization is insufficient compared to expected behavior
 *   [PASS]    — optimization works correctly (green baseline for comparison)
 *
 * These cases were added after real optimizer regressions/bugs and should
 * remain green to prevent future regressions.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { PrimitiveTypes } from "../../../src/transpiler/frontend/type_symbols";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";
import { TACOptimizer } from "../../../src/transpiler/ir/optimizer/index.js";
import {
  type AssignmentInstruction,
  BinaryOpInstruction,
  ReturnInstruction,
  TACInstructionKind,
} from "../../../src/transpiler/ir/tac_instruction";
import {
  type ConstantOperand,
  createConstant,
  createTemporary,
  TACOperandKind,
  type TemporaryOperand,
} from "../../../src/transpiler/ir/tac_operand";

beforeAll(() => {
  buildExternRegistryFromFiles([]);
});

/** Strip trailing comments outside of quoted strings */
function stripTrailingComment(raw: string): string {
  const m = raw.match(/^([^"]*(?:"[^"]*"[^"]*)*)\/\//);
  return m ? m[1].trim() : raw;
}

/** Count instruction lines in UASM code section (PUSH, EXTERN, JUMP, etc.) */
function countUasmInstructions(uasm: string): number {
  const lines = uasm.split("\n").map((l) => l.trim());
  let inCode = false;
  let count = 0;
  for (const trimmed of lines) {
    const line = stripTrailingComment(trimmed);
    if (line === ".code_start") {
      inCode = true;
      continue;
    }
    if (line === ".code_end") {
      inCode = false;
      continue;
    }
    if (!inCode) continue;
    // Skip empty lines, full-line comments
    if (!line || line.startsWith("//") || line.startsWith("#")) continue;
    // Skip labels (e.g. "_start:") — strip comments first so "label: // ..." is handled
    if (line.endsWith(":") && !line.includes(",")) continue;
    // Skip directives
    if (line.startsWith(".")) continue;
    // NOP is excluded from instruction count (same as uasm_parser)
    if (line === "NOP") continue;
    count++;
  }
  return count;
}

describe("optimizer regression tests", () => {
  // ─────────────────────────────────────────────────────────────────────────
  // [BUG] tail_merge crash on if/else-if/else with instance field access
  // ─────────────────────────────────────────────────────────────────────────
  describe("[BUG] tail_merge crash", () => {
    it("does not crash on if/else-if/else with property access and Debug.Log", () => {
      const source = `
        import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
        import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
        import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
        import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

        @UdonBehaviour()
        export class TailMergeTest extends UdonSharpBehaviour {
          private mode: UdonInt = 0 as UdonInt;
          Start(): void {
            this.mode = 1 as UdonInt;
            if (this.mode === (1 as UdonInt)) {
              Debug.Log("mode one");
            } else if (this.mode === (2 as UdonInt)) {
              Debug.Log("mode two");
            } else {
              Debug.Log("other");
            }
          }
        }
      `;
      const transpiler = new TypeScriptToUdonTranspiler();
      expect(() =>
        transpiler.transpile(source, { optimize: true }),
      ).not.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // [BUG] exported entry labels missing after optimization
  // ─────────────────────────────────────────────────────────────────────────
  describe("[BUG] _start export pruned by optimizer", () => {
    it("always exports _start even when optimization prunes methods", () => {
      const source = `
        import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
        import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
        import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
        import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

        @UdonBehaviour()
        export class RealisticTest extends UdonSharpBehaviour {
          private score: UdonInt = 0 as UdonInt;
          private highScore: UdonInt = 0 as UdonInt;
          private isPlaying: boolean = false;
          Start(): void {
            this.score = 0 as UdonInt;
            this.highScore = 100 as UdonInt;
            this.isPlaying = true;
          }
          AddScore(points: UdonInt): void {
            if (!this.isPlaying) return;
            this.score = (this.score + points) as UdonInt;
            if (this.score > this.highScore) {
              this.highScore = this.score;
              Debug.Log("New high score!");
            }
            const msg: string = \`Score: \${this.score.toString()}\`;
            Debug.Log(msg);
          }
          ResetGame(): void {
            this.score = 0 as UdonInt;
            this.isPlaying = true;
            Debug.Log("Game reset");
          }
          GetScore(): UdonInt { return this.score; }
          GetHighScore(): UdonInt { return this.highScore; }
        }
      `;
      const transpiler = new TypeScriptToUdonTranspiler();
      const result = transpiler.transpile(source, { optimize: true });
      expect(result.uasm).toContain(".export _start");
      const expectedPublicExports = [
        "__0_AddScore",
        "ResetGame",
        "GetScore",
        "GetHighScore",
      ];
      for (const label of expectedPublicExports) {
        expect(result.uasm).toContain(`.export ${label}`);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // [REGRESS] diamond_simp: SSA reconstruction inflates instruction count
  // ─────────────────────────────────────────────────────────────────────────
  describe("[REGRESS] diamond simplification SSA inflation", () => {
    it("optimization should not increase instruction count for ternary patterns", () => {
      const source = `
        import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
        import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
        import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
        import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

        @UdonBehaviour()
        export class DiamondSimpTest extends UdonSharpBehaviour {
          private score: UdonInt = 0 as UdonInt;
          Start(): void {
            this.score = 75 as UdonInt;
            const passed: boolean = this.score >= (60 as UdonInt) ? true : false;
            const failed: boolean = this.score < (60 as UdonInt) ? true : false;
            Debug.Log(passed);
            Debug.Log(failed);
          }
        }
      `;
      const transpiler = new TypeScriptToUdonTranspiler();
      const baseline = transpiler.transpile(source, { optimize: false });
      const optimized = transpiler.transpile(source, { optimize: true });
      const baselineCount = countUasmInstructions(baseline.uasm);
      const optimizedCount = countUasmInstructions(optimized.uasm);

      expect(optimizedCount).toBeLessThanOrEqual(baselineCount);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // [REGRESS] loop optimization: SSA overhead increases instructions
  // ─────────────────────────────────────────────────────────────────────────
  describe("[REGRESS] loop optimization SSA overhead", () => {
    it("optimization should not increase instruction count for fibonacci loop", () => {
      const source = `
        import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
        import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
        import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
        import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

        @UdonBehaviour()
        export class FibonacciTest extends UdonSharpBehaviour {
          Start(): void {
            let a: UdonInt = 0 as UdonInt;
            let b: UdonInt = 1 as UdonInt;
            for (let i: UdonInt = 0 as UdonInt; i < (10 as UdonInt); i++) {
              Debug.Log(a);
              const temp: UdonInt = (a + b) as UdonInt;
              a = b;
              b = temp;
            }
          }
        }
      `;
      const transpiler = new TypeScriptToUdonTranspiler();
      const baseline = transpiler.transpile(source, { optimize: false });
      const optimized = transpiler.transpile(source, { optimize: true });
      const baselineCount = countUasmInstructions(baseline.uasm);
      const optimizedCount = countUasmInstructions(optimized.uasm);

      expect(optimizedCount).toBeLessThanOrEqual(baselineCount);
    });

    it("optimization should not increase instruction count for simple loop unroll", () => {
      const source = `
        import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
        import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
        import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
        import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

        @UdonBehaviour()
        export class LoopUnrollTest extends UdonSharpBehaviour {
          Start(): void {
            let sum: UdonInt = 0 as UdonInt;
            for (let i: UdonInt = 0 as UdonInt; i < (3 as UdonInt); i++) {
              sum = (sum + i) as UdonInt;
            }
            Debug.Log(sum);
          }
        }
      `;
      const transpiler = new TypeScriptToUdonTranspiler();
      const baseline = transpiler.transpile(source, { optimize: false });
      const optimized = transpiler.transpile(source, { optimize: true });
      const baselineCount = countUasmInstructions(baseline.uasm);
      const optimizedCount = countUasmInstructions(optimized.uasm);

      expect(optimizedCount).toBeLessThanOrEqual(baselineCount);
    });

    it("optimization should not increase instruction count for LICM pattern", () => {
      const source = `
        import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
        import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
        import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
        import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

        @UdonBehaviour()
        export class LicmTest extends UdonSharpBehaviour {
          Start(): void {
            const baseVal: UdonInt = 10 as UdonInt;
            const mult: UdonInt = 3 as UdonInt;
            let sum: UdonInt = 0 as UdonInt;
            for (let i: UdonInt = 0 as UdonInt; i < (5 as UdonInt); i++) {
              const invariant: UdonInt = (baseVal * mult) as UdonInt;
              sum = (sum + invariant) as UdonInt;
            }
            Debug.Log(sum);
          }
        }
      `;
      const transpiler = new TypeScriptToUdonTranspiler();
      const baseline = transpiler.transpile(source, { optimize: false });
      const optimized = transpiler.transpile(source, { optimize: true });
      const baselineCount = countUasmInstructions(baseline.uasm);
      const optimizedCount = countUasmInstructions(optimized.uasm);

      expect(optimizedCount).toBeLessThanOrEqual(baselineCount);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // [KNOWN FAIL] compare:uasm 未改善ケース（fix時に it.fails を外す）
  // ─────────────────────────────────────────────────────────────────────────
  describe("[KNOWN FAIL] UdonSharp parity gaps", () => {
    it.fails("array_index_mutation should stay on Int32Array path (why: still widened to SingleArray)", () => {
      const source = `
        import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
        import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
        import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

        @UdonBehaviour()
        export class ArrayIndexMutationTest extends UdonSharpBehaviour {
          Start(): void {
            const values: number[] = [1, 2, 3, 4];
            values[1] = values[0] + values[2];
            values[3] = values[1] * 2;
            Debug.Log(values[1]);
            Debug.Log(values[3]);
          }
        }
      `;
      const transpiler = new TypeScriptToUdonTranspiler();
      const optimized = transpiler.transpile(source, { optimize: true });
      const optimizedCount = countUasmInstructions(optimized.uasm);

      expect(optimized.uasm).toContain(
        "SystemInt32Array.__ctor__SystemInt32__SystemInt32Array",
      );
      expect(optimized.uasm).not.toMatch(
        /SystemSingleArray|SystemConvert\.__ToDouble__SystemSingle__SystemDouble|SystemMath\.__Truncate__SystemDouble__SystemDouble|SystemConvert\.__ToInt32__SystemDouble__SystemInt32/,
      );
      expect(optimizedCount).toBeLessThanOrEqual(63);
    });

    it.fails("array_reassign_then_read should avoid float-conversion array pipeline (why: still SingleArray-based)", () => {
      const source = `
        import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
        import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
        import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

        @UdonBehaviour()
        export class ArrayReassignThenReadTest extends UdonSharpBehaviour {
          Start(): void {
            const values = [2, 4, 6];
            values[0] = values[1] + 1;
            values[2] = values[0] + values[1];
            Debug.Log(values[0]);
            Debug.Log(values[2]);
          }
        }
      `;
      const transpiler = new TypeScriptToUdonTranspiler();
      const optimized = transpiler.transpile(source, { optimize: true });
      const optimizedCount = countUasmInstructions(optimized.uasm);

      expect(optimized.uasm).toContain(
        "SystemInt32Array.__ctor__SystemInt32__SystemInt32Array",
      );
      expect(optimized.uasm).not.toMatch(
        /SystemSingleArray|SystemConvert\.__ToDouble__SystemSingle__SystemDouble|SystemMath\.__Truncate__SystemDouble__SystemDouble|SystemConvert\.__ToInt32__SystemDouble__SystemInt32/,
      );
      expect(optimizedCount).toBeLessThanOrEqual(59);
    });

    it.fails("early_return_guard should not inject __asm_restrict_eq_extern (why: optimized still emits guard artifact)", () => {
      const source = `
        import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
        import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
        import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

        @UdonBehaviour()
        export class EarlyReturnGuardTest extends UdonSharpBehaviour {
          private isReady = false;

          Start(): void {
            if (!this.isReady) {
              Debug.Log("skip");
              return;
            }
            Debug.Log("run");
          }
        }
      `;
      const transpiler = new TypeScriptToUdonTranspiler();
      const optimized = transpiler.transpile(source, { optimize: true });
      const optimizedCount = countUasmInstructions(optimized.uasm);

      expect(optimized.uasm).not.toContain("__asm_restrict_eq_extern");
      expect(optimized.uasm).not.toContain(
        "SystemBoolean.__op_UnaryNegation__SystemBoolean__SystemBoolean",
      );
      expect(optimizedCount).toBeLessThanOrEqual(14);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // [GAP] constant folding: chain of constant arithmetic should fully fold
  // ─────────────────────────────────────────────────────────────────────────
  describe("[GAP] constant folding chain", () => {
    it("folds a chain of constant arithmetic to a single value at TAC level", () => {
      // t0 = 2 + 3   → 5
      // t1 = t0 * 4  → 20
      // t2 = 100 / 5 → 20
      // t3 = t1 + t2 → 40
      const t0 = createTemporary(0, PrimitiveTypes.int32);
      const t1 = createTemporary(1, PrimitiveTypes.int32);
      const t2 = createTemporary(2, PrimitiveTypes.int32);
      const t3 = createTemporary(3, PrimitiveTypes.int32);

      const instructions = [
        new BinaryOpInstruction(
          t0,
          createConstant(2, PrimitiveTypes.int32),
          "+",
          createConstant(3, PrimitiveTypes.int32),
        ),
        new BinaryOpInstruction(
          t1,
          t0,
          "*",
          createConstant(4, PrimitiveTypes.int32),
        ),
        new BinaryOpInstruction(
          t2,
          createConstant(100, PrimitiveTypes.int32),
          "/",
          createConstant(5, PrimitiveTypes.int32),
        ),
        new BinaryOpInstruction(t3, t1, "+", t2),
        new ReturnInstruction(t3),
      ];

      const optimizer = new TACOptimizer();
      const optimized = optimizer.optimize(instructions);

      // After full optimization, the chain should fold to a single constant 40.
      // There should be no BinaryOp instructions remaining.
      const hasBinaryOp = optimized.some(
        (inst) => inst.kind === TACInstructionKind.BinaryOp,
      );
      expect(hasBinaryOp).toBe(false);

      // The return value should ultimately resolve to the constant 40.
      const retInst = optimized.find(
        (inst) => inst.kind === TACInstructionKind.Return,
      ) as ReturnInstruction | undefined;
      if (!retInst?.value) {
        return expect.fail("missing return instruction or return value");
      }
      const retValue = retInst.value;
      if (retValue.kind === TACOperandKind.Constant) {
        expect((retValue as ConstantOperand).value).toBe(40);
      } else if (retValue.kind === TACOperandKind.Temporary) {
        // The return references a temporary — find the assignment that
        // defines this specific temporary and verify its constant value.
        const retTempId = (retValue as TemporaryOperand).id;
        const assignInst = optimized.find(
          (inst) =>
            inst.kind === TACInstructionKind.Assignment &&
            (inst as AssignmentInstruction).dest.kind ===
              TACOperandKind.Temporary &&
            ((inst as AssignmentInstruction).dest as TemporaryOperand).id ===
              retTempId &&
            (inst as AssignmentInstruction).src.kind ===
              TACOperandKind.Constant,
        ) as AssignmentInstruction | undefined;
        if (!assignInst) {
          return expect.fail(`no constant assignment for temp ${retTempId}`);
        }
        expect((assignInst.src as ConstantOperand).value).toBe(40);
      } else {
        expect.fail(
          `expected return operand to be Constant or Temporary, got ${retValue.kind}`,
        );
      }
    });

    it("end-to-end: constant arithmetic chain produces fewer externs when optimized", () => {
      const source = `
        import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
        import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
        import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
        import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

        @UdonBehaviour()
        export class ConstFoldTest extends UdonSharpBehaviour {
          Start(): void {
            const a: UdonInt = ((2 as UdonInt) + (3 as UdonInt)) as UdonInt;
            const b: UdonInt = (a * (4 as UdonInt)) as UdonInt;
            const c: UdonInt = ((100 as UdonInt) / (5 as UdonInt)) as UdonInt;
            const d: UdonInt = (b + c) as UdonInt;
            Debug.Log(d);
          }
        }
      `;
      const transpiler = new TypeScriptToUdonTranspiler();
      const baseline = transpiler.transpile(source, { optimize: false });
      const optimized = transpiler.transpile(source, { optimize: true });

      // Count EXTERN calls (arithmetic ops that should be folded away)
      const countExterns = (uasm: string) =>
        uasm.split("\n").filter((l) => l.trim().startsWith("EXTERN,")).length;

      const baselineExterns = countExterns(baseline.uasm);
      const optimizedExterns = countExterns(optimized.uasm);

      // The optimizer should fold at least some of the arithmetic EXTERN calls.
      // Ideally: 4 arithmetic + 1 Debug.Log → only 1 Debug.Log
      // At minimum: fewer externs than baseline.
      expect(optimizedExterns).toBeLessThan(baselineExterns);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // [PASS] algebraic simplification: x+0, x*1, x*0 correctly simplified
  // ─────────────────────────────────────────────────────────────────────────
  describe("[PASS] algebraic simplification with field access", () => {
    it("optimization should produce fewer instructions than baseline for identity operations", () => {
      const source = `
        import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
        import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
        import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
        import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

        @UdonBehaviour()
        export class AlgebraicTest extends UdonSharpBehaviour {
          private value: UdonInt = 0 as UdonInt;
          Start(): void {
            this.value = 10 as UdonInt;
            const a: UdonInt = (this.value + (0 as UdonInt)) as UdonInt;
            const b: UdonInt = (this.value * (1 as UdonInt)) as UdonInt;
            const c: UdonInt = (this.value - (0 as UdonInt)) as UdonInt;
            const d: UdonInt = (this.value * (0 as UdonInt)) as UdonInt;
            Debug.Log(a);
            Debug.Log(b);
            Debug.Log(c);
            Debug.Log(d);
          }
        }
      `;
      const transpiler = new TypeScriptToUdonTranspiler();
      const baseline = transpiler.transpile(source, { optimize: false });
      const optimized = transpiler.transpile(source, { optimize: true });
      const baselineCount = countUasmInstructions(baseline.uasm);
      const optimizedCount = countUasmInstructions(optimized.uasm);

      // Algebraic simplification should remove identity arithmetic ops
      expect(optimizedCount).toBeLessThan(baselineCount);
    });
  });
});
