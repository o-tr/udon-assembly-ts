/**
 * Regression tests for Bug A: recursive inline stack saves of Int32-backed
 * locals via op_Implicit__SystemDouble.
 *
 * Root cause: visitVariableDeclaration narrowed a `number`-declared (Double)
 * variable to %SystemInt32 when the initializer produced an Int32 (e.g. DataToken
 * unwrap of a UdonInt[] + `as number` brand-strip). collectRecursiveLocals
 * records the declared AST type (Double for `number`). At the recursive
 * call-site push, wrapDataToken creates localVar with local.type=Double, which
 * codegen maps to the %SystemInt32 address, then emits
 * op_Implicit__SystemDouble on the Int32 slot → Udon VM crash.
 *
 * Fix: visitVariableDeclaration no longer narrows Double/Single→Int; it inserts
 * a CastInstruction to widen the value, so the slot stays %SystemDouble and
 * wrapDataToken operates on a properly-typed Double value.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

beforeAll(() => {
  buildExternRegistryFromFiles([]);
});

/**
 * Returns a map of variable-name → declared UASM type extracted from the
 * .uasm data section declarations (e.g. `k3: %SystemDouble, null`).
 */
function extractUasmSlotTypes(uasm: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of uasm.split("\n")) {
    const m = /^\s*([\w]+): (%\w+)/.exec(line);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

describe("recursive stack numeric type consistency (Bug A)", () => {
  it("number local assigned from Int32 DataToken unwrap should save as Double not crash", () => {
    // Mimics: const c1 = counts[k1] as number inside a @RecursiveMethod where
    // counts is UdonInt[] (Int32-typed DataList). Before the fix, the F2 brand-
    // strip in visitAsExpression returned the Int32 operand unchanged, and
    // visitVariableDeclaration narrowed c1 to %SystemInt32. wrapDataToken then
    // emitted op_Implicit__SystemDouble on the Int32 slot → runtime crash.
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";

      function RecursiveMethod(_t: object, _k: string, d: PropertyDescriptor): PropertyDescriptor { return d; }

      @UdonBehaviour()
      export class RecStackBugA extends UdonSharpBehaviour {
        @RecursiveMethod
        compute(counts: UdonInt[], firstKind: number): number {
          const k1 = firstKind;
          const k3 = firstKind + 2;
          const c1 = counts[k1] as number;
          if (c1 <= 0) return 0;
          return c1 + this.compute(counts, firstKind - 1);
        }

        Start(): void {
          this.compute([] as any, 2);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const slotTypes = extractUasmSlotTypes(result.uasm);

    // c1 declared as `number` (Double). Must stay %SystemDouble so that
    // wrapDataToken can call op_Implicit__SystemDouble correctly.
    expect(slotTypes.get("c1")).toBe("%SystemDouble");

    // k1 declared as `number` (Double). Must stay %SystemDouble.
    expect(slotTypes.get("k1")).toBe("%SystemDouble");

    // The UASM must contain op_Implicit__SystemDouble (for wrapping Double
    // locals to the recursive stack). Absence would mean the fix broke
    // the wrapping mechanism entirely.
    expect(result.uasm).toContain("__op_Implicit__SystemDouble");

    // No %SystemInt32 slot should appear for c1 (pre-fix this was the bug).
    expect(slotTypes.get("c1")).not.toBe("%SystemInt32");
  });

  it("number local from plain Int32 BinaryOp should stay Double in recursive method", () => {
    // Simpler case: const k = n + 2 where both n and 2 are resolved to Double
    // via currentExpectedType propagation. Verify no regression.
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";

      function RecursiveMethod(_t: object, _k: string, d: PropertyDescriptor): PropertyDescriptor { return d; }

      @UdonBehaviour()
      export class RecStackSimple extends UdonSharpBehaviour {
        @RecursiveMethod
        compute(n: number): number {
          const k = n + 2;
          if (k <= 0) return 0;
          return k + this.compute(n - 1);
        }

        Start(): void {
          this.compute(5);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const slotTypes = extractUasmSlotTypes(result.uasm);

    // k should be %SystemDouble (stays Double since n+2 is Double+Double=Double)
    expect(slotTypes.get("k")).toBe("%SystemDouble");
    expect(result.uasm).toContain("__op_Implicit__SystemDouble");
  });

  it("should not have %SystemInt32 slot for number-typed variable in recursive method", () => {
    // Verify the fix: number-declared locals in @RecursiveMethod must not be
    // narrowed to Int32, regardless of their initializer type.
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";

      function RecursiveMethod(_t: object, _k: string, d: PropertyDescriptor): PropertyDescriptor { return d; }

      @UdonBehaviour()
      export class RecStackConsistency extends UdonSharpBehaviour {
        @RecursiveMethod
        process(counts: UdonInt[], n: number): number {
          const local1 = n + 1;
          const local2 = counts[0] as number;
          if (local2 <= 0) return local1;
          return local1 + this.process(counts, n - 1);
        }

        Start(): void {
          this.process([] as any, 3);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const slotTypes = extractUasmSlotTypes(result.uasm);

    // Both locals are declared as `number` → must stay %SystemDouble
    expect(slotTypes.get("local1")).toBe("%SystemDouble");
    expect(slotTypes.get("local2")).toBe("%SystemDouble");

    // Sanity: output compiles without errors
    expect(result.uasm).toContain("EXTERN");
  });
});
