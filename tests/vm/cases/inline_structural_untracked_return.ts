import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

// Repro for UntrackedStructuralUnionReturn bug.
//
// Inner.getInfo uses `tryGet(x) ?? fallback` where tryGet is a method call
// (not side-effect-free). The null-coalescing split is skipped → the NC
// result is an untracked Temporary → returnTrackingInvalidated=true for
// Inner.getInfo → its returnVar (__inline_ret_N) is NOT in inlineInstanceMap
// after the body AND __inline_ret_N_found/_count are never in symbolTable.
//
// Outer.analyze:
//   - First return (if x > 100): returns the result of Inner.getInfo, which is
//     an untracked Variable with no named field slots → UntrackedStructuralUnionReturn
//   - Last return: inline literal → tracked → sets inlineInstanceMap[returnVar]
//
// Caller uses direct prefix reads because the LAST return was tracked.
// At runtime:
//   Call 1 (x=50): takes the LAST return (literal) → prefix updated {count:99}
//   Call 2 (x=200): takes the FIRST return (untracked) → prefix NOT updated
//     → caller reads stale count=99 instead of count=200

type WaitInfo = { found: boolean; count: number };

class Inner {
  static tryGet(x: number): WaitInfo | null {
    // Ternary-split → each branch is a tracked return; tryGet's returnVar IS tracked.
    // But its return type is WaitInfo | null (nullable), so getInfo can use ??.
    return x > 0 ? { found: true, count: x } : null;
  }

  static getInfo(x: number): WaitInfo {
    // NC with method call on left → isSideEffectFreeNullCoalesceLeft = false
    // → NC split skipped → visitNullCoalescingExpression produces a Temporary
    // → `return <Temporary>` hits the else branch in the return handler
    // → returnTrackingInvalidated = true for getInfo's inline context
    // → getInfo's returnVar is NOT in inlineInstanceMap after the body
    // → no named field slots (__inline_ret_N_found/_count) in symbolTable
    return Inner.tryGet(x) ?? { found: false, count: 0 };
  }
}

class Outer {
  static analyze(x: number): WaitInfo {
    const result = Inner.getInfo(x);
    if (x > 100) {
      return result; // FIRST in source: UntrackedStructuralUnionReturn
    }
    return { found: true, count: 99 }; // LAST in source: tracked
  }
}

// Covers the saveAndBindInlineParams propagation path:
// an already-untracked local is forwarded through a parameter and then
// returned directly from the callee, which should also trigger
// returnTrackingInvalidated (via untrackedStructuralHandleVars propagation
// from arg → param in saveAndBindInlineParams).
class Wrapper {
  static wrap(p: WaitInfo): WaitInfo {
    return p;
  }
}

class OuterViaWrap {
  static analyzeViaWrap(x: number): WaitInfo {
    const result = Inner.getInfo(x); // untracked (NC with method-call LHS)
    if (x > 100) {
      // result is untracked → saveAndBindInlineParams propagates to p
      // → `return p` triggers returnTrackingInvalidated → D-3 dispatch
      return Wrapper.wrap(result);
    }
    return { found: true, count: 99 }; // tracked sibling
  }
}

@UdonBehaviour()
export class InlineStructuralUntrackedReturn extends UdonSharpBehaviour {
  Start(): void {
    // Call 1: x=50 → takes literal path → prefix = {found:true, count:99}
    const r1 = Outer.analyze(50);
    Debug.Log(r1.found); // True
    Debug.Log(r1.count); // 99

    // Call 2: x=200 → takes untracked result path
    // With bug: reads stale count=99 (wrong, should be 200)
    // After fix: should read count=200
    const r2 = Outer.analyze(200);
    Debug.Log(r2.found); // True
    Debug.Log(r2.count); // 200

    // Call 3 & 4: same via the param-forwarding path (OuterViaWrap)
    const r3 = OuterViaWrap.analyzeViaWrap(50);
    Debug.Log(r3.found); // True
    Debug.Log(r3.count); // 99

    const r4 = OuterViaWrap.analyzeViaWrap(200);
    Debug.Log(r4.found); // True
    Debug.Log(r4.count); // 200
  }
}
