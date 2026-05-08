/**
 * Regression tests for the parameter-direct-return pattern with untracked
 * structural-union arguments (tenpai-correctness-regression).
 *
 * HandAnalyzer.ts:229,872 pattern:
 *   static method(p: T | null): T { if (p === null) return literal; return p; }
 *
 * When the argument is an untracked handle (result of NC with method-call LHS),
 * the saveAndBindInlineParams propagation must fire:
 *   untrackedStructuralHandleVars.has(argKey) → add param to untracked set
 *   → inlineInstanceMap.delete(param)
 *   → `return p` → UntrackedStructuralUnionReturn → returnTrackingInvalidated
 *   → caller emits __uninst_prop_* (D-3 dispatch) instead of direct prefix reads
 *
 * If D-3 dispatch is missing, the caller reads stale prefix slots and gets
 * wrong values at runtime (the bug this file guards against).
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry.js";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";
import { getStartSection } from "./test_helpers.js";

const PARAM_DIRECT_RETURN_SOURCE = `
  import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
  import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
  import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

  type WaitInfo = { found: boolean; count: number };

  class Inner {
    static tryGet(x: number): WaitInfo | null {
      return x > 0 ? { found: true, count: x } : null;
    }
    static getInfo(x: number): WaitInfo {
      // NC with method-call LHS → split skipped → Temporary result
      // → returnTrackingInvalidated for getInfo → caller's inline-ret is untracked
      return Inner.tryGet(x) ?? { found: false, count: 0 };
    }
  }

  class HandAnalyzer {
    // Parameter-direct-return: same pattern as HandAnalyzer.ts:229,872
    static passThrough(p: WaitInfo | null): WaitInfo {
      if (p === null) return { found: false, count: -1 }; // tracked literal sibling
      return p; // UntrackedStructuralUnionReturn — should set returnTrackingInvalidated
    }
  }

  @UdonBehaviour()
  export class TestBehaviour extends UdonSharpBehaviour {
    Start(): void {
      // Case 1: pass null literal — null-narrowing kills the "return p" path at runtime
      const r1 = HandAnalyzer.passThrough(null);
      Debug.Log(r1.count);

      // Case 2: pass tracked WaitInfo from object literal — argInfo in inlineInstanceMap
      const tracked: WaitInfo = { found: true, count: 42 };
      const r2 = HandAnalyzer.passThrough(tracked);
      Debug.Log(r2.count);

      // Case 3: pass result of Inner.getInfo (untracked from NC)
      // untrackedStructuralHandleVars must propagate arg → param p
      // so that "return p" fires returnTrackingInvalidated
      // → caller must emit __uninst_prop_* for D-3 dispatch
      const fromNC = Inner.getInfo(5);
      const r3 = HandAnalyzer.passThrough(fromNC);
      Debug.Log(r3.count); // Must use D-3 dispatch, not stale prefix read
    }
  }
`;

describe("tenpai param-direct-return regression", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("case 3: untracked NC result passed to param-returning method uses D-3 dispatch", () => {
    const result = new TypeScriptToUdonTranspiler().transpile(
      PARAM_DIRECT_RETURN_SOURCE,
    );

    const startSection = getStartSection(result.tac);

    // The property access r3.count after passing an untracked arg must use
    // D-3 dispatch (uninst_prop pattern) rather than a direct prefix read.
    // A direct prefix read would look like:
    //   COPY dest, __inline_ret_passThrough_count
    // while D-3 dispatch looks like:
    //   CALL __uninst_prop_<N>
    expect(startSection).toMatch(/__uninst_prop_\d+/);
  });

  it("case 2: tracked object literal arg uses direct prefix reads (no D-3)", () => {
    // When the arg IS tracked (from a literal), the caller should use the fast
    // direct prefix read path, not D-3 dispatch. This ensures we don't
    // over-trigger the untracked propagation.
    const trackedOnlySource = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

      type WaitInfo = { found: boolean; count: number };

      class HandAnalyzer {
        static passThrough(p: WaitInfo | null): WaitInfo {
          if (p === null) return { found: false, count: -1 };
          return p;
        }
      }

      @UdonBehaviour()
      export class TestBehaviour extends UdonSharpBehaviour {
        Start(): void {
          const tracked: WaitInfo = { found: true, count: 42 };
          const r = HandAnalyzer.passThrough(tracked);
          Debug.Log(r.count);
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(
      trackedOnlySource,
    );
    const startSection = getStartSection(result.tac);

    // With a tracked arg, D-3 dispatch must NOT fire at the call site.
    // Scope to the Start section (not the full TAC) so that __uninst_prop slots
    // in passThrough's internal body (literal sibling returns) don't produce
    // false positives.
    expect(startSection).not.toMatch(/__uninst_prop_\d+/);
  });

  it("emits UntrackedStructuralUnionReturn diagnostic for param-direct-return", () => {
    const result = new TypeScriptToUdonTranspiler().transpile(
      PARAM_DIRECT_RETURN_SOURCE,
    );

    const diag = result.diagnostics?.find(
      (d) => d.code === "UntrackedStructuralUnionReturn",
    );
    expect(diag).toBeDefined();
  });
});
