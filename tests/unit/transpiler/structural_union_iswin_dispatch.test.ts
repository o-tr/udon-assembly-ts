/**
 * Regression tests for the structural-union SystemObject.__get_isWin bug.
 *
 * When a method returning a structural union (StandardWin | ChiitoitsuWin)
 * has one return path that is untracked (NC with method-call LHS) and one
 * that is tracked (literal), the caller's property access on `.isWin` must
 * NOT emit `SystemObject.__get_isWin__SystemBoolean`.  That extern is invalid
 * and Unity rejects it at runtime with NotSupportedException.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import type { DispatchLimitResolver } from "../../../src/transpiler/ir/ast_to_tac/dispatch_limit_resolver.js";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

describe("structural union isWin dispatch", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("does not emit SystemObject.__get_isWin for untracked structural-union return (NC method-call LHS)", () => {
    // Repro for the yaku_yakuman / win_chiitoitsu / scoring_fu failures:
    //
    // WinAnalyzer.tryWin uses `tryGet(x) ?? fallback` where tryGet is a
    // method call (not side-effect-free). The NC split is skipped → the
    // result is an untracked Temporary → returnTrackingInvalidated=true for
    // WinAnalyzer.tryWin → its returnVar is NOT in inlineInstanceMap.
    //
    // Outer.analyze:
    //   - First return (x > 100): returns result of tryWin (untracked)
    //     → UntrackedStructuralUnionReturn → returnTrackingInvalidated=true
    //   - Last return: inline literal → if returnTrackingInvalidated is
    //     already true, field copies are NOT emitted for the return prefix
    //     → returnVar_isWin is NEVER declared in symbolTable
    //
    // In Start, `const r = Outer.analyze(200)`:
    //   sourcePrefixFromNamedSlots = false (returnVar_isWin not in symbolTable)
    //   → r goes to untrackedStructuralHandleVars, NOT inlineInstanceMap
    //   → r.isWin falls through to D3 dispatch
    //
    // D3 dispatch must succeed with the concrete win instances.
    // If it fails (missing anonUnionIface or dispatchLimit exceeded), it
    // falls through to PropertyGetInstruction → invalid EXTERN.
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

      type StandardWin = { isWin: boolean; fu: number };
      type ChiitoitsuWin = { isWin: boolean; han: number };
      type WinResult = StandardWin | ChiitoitsuWin;

      class WinChecker {
        static tryStandard(x: number): WinResult | null {
          return x > 0
            ? { isWin: true, fu: x }
            : null;
        }

        static getWin(x: number): WinResult {
          // NC with method-call LHS → isSideEffectFreeNullCoalesceLeft=false
          // → NC split skipped → result is an untracked Temporary
          // → returnTrackingInvalidated=true for getWin
          return WinChecker.tryStandard(x) ?? { isWin: false, han: 0 };
        }
      }

      class Outer {
        static analyze(x: number): WinResult {
          const result = WinChecker.getWin(x);
          if (x > 100) {
            return result; // UntrackedStructuralUnionReturn
          }
          return { isWin: true, han: 7 }; // tracked sibling
        }
      }

      @UdonBehaviour()
      export class IsWinDispatchTest extends UdonSharpBehaviour {
        Start(): void {
          const r1 = Outer.analyze(50);
          Debug.Log(r1.isWin);

          const r2 = Outer.analyze(200);
          Debug.Log(r2.isWin);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    // Must not emit the invalid SystemObject extern that Unity rejects.
    expect(result.uasm).not.toMatch(/SystemObject\.__get_isWin__SystemBoolean/);
    // Must not emit a PropertyGetInstruction for isWin on a SystemObject handle.
    expect(result.uasm).not.toMatch(/__get_isWin/);
  });

  it("does not emit SystemObject.__get_isWin via param-forwarding path", () => {
    // Covers the saveAndBindInlineParams propagation path:
    // an already-untracked local is forwarded through a parameter and
    // returned directly from the callee. The property access on the
    // outer result must still not produce SystemObject.__get_isWin.
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

      type StandardWin = { isWin: boolean; fu: number };
      type ChiitoitsuWin = { isWin: boolean; han: number };
      type WinResult = StandardWin | ChiitoitsuWin;

      class WinChecker {
        static tryStandard(x: number): WinResult | null {
          return x > 0 ? { isWin: true, fu: x } : null;
        }
        static getWin(x: number): WinResult {
          return WinChecker.tryStandard(x) ?? { isWin: false, han: 0 };
        }
      }

      class Wrapper {
        static wrap(p: WinResult): WinResult {
          return p;
        }
      }

      class OuterViaWrap {
        static analyzeViaWrap(x: number): WinResult {
          const result = WinChecker.getWin(x);
          if (x > 100) {
            return Wrapper.wrap(result);
          }
          return { isWin: true, han: 7 };
        }
      }

      @UdonBehaviour()
      export class IsWinWrapDispatchTest extends UdonSharpBehaviour {
        Start(): void {
          const r1 = OuterViaWrap.analyzeViaWrap(50);
          Debug.Log(r1.isWin);

          const r2 = OuterViaWrap.analyzeViaWrap(200);
          Debug.Log(r2.isWin);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    expect(result.uasm).not.toMatch(/SystemObject\.__get_isWin__SystemBoolean/);
    expect(result.uasm).not.toMatch(/__get_isWin/);
  });

  it("does not emit SystemObject.__get_isWin when dispatch limit is exceeded (regression: anonUnionIface path)", () => {
    // Regression for the production mahjong case: when the program has many
    // inline instances (> DEFAULT_DISPATCH_LIMIT = 100), the anonUnionIface
    // path populates dispInstances but dispInstances.length > dispatchLimit
    // causes the entire dispatch block to be skipped.  usedErasedFallback is
    // false for the anonUnionIface path, so the miss path inside the block
    // is also skipped → silent fallthrough to PropertyGetInstruction →
    // SystemObject.__get_isWin__SystemBoolean → NotSupportedException at
    // VRChat runtime.
    //
    // Simulated here with dispatchLimitResolver.getLimit = () => 1 so that
    // even the 3 instances in this test exceed the limit.
    const tinyResolver: DispatchLimitResolver = {
      getLimit: () => 1,
      isLargeErasedFallbackProperty: () => false,
    };
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

      type StandardWin = { isWin: boolean; fu: number };
      type ChiitoitsuWin = { isWin: boolean; han: number };
      type WinResult = StandardWin | ChiitoitsuWin;

      class WinChecker {
        static tryStandard(x: number): WinResult | null {
          return x > 0 ? { isWin: true, fu: x } : null;
        }
        static getWin(x: number): WinResult {
          return WinChecker.tryStandard(x) ?? { isWin: false, han: 0 };
        }
      }

      class Outer {
        static analyze(x: number): WinResult {
          const result = WinChecker.getWin(x);
          if (x > 100) {
            return result;
          }
          return { isWin: true, han: 7 };
        }
      }

      @UdonBehaviour()
      export class IsWinLimitTest extends UdonSharpBehaviour {
        Start(): void {
          const r = Outer.analyze(200);
          Debug.Log(r.isWin);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      dispatchLimitResolver: tinyResolver,
    });

    // Even with a tiny dispatch limit that forces limit-exceeded path, the
    // compiler must NOT emit the invalid SystemObject extern.  The miss path
    // must emit Debug.LogError instead.
    expect(result.uasm).not.toMatch(/SystemObject\.__get_isWin__SystemBoolean/);
    expect(result.uasm).not.toMatch(/__get_isWin/);
  });
});
