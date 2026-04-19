import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import {
  type UdonInt,
  UdonTypeConverters,
} from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

// PR #170 residual regression: null-literal arg into a `Result | null`
// parameter. PR #170 strips `| null` branches during structural union
// resolution, but when a caller passes a bare `null` literal as an
// argument of type `Result | null`, the callee's branching misinterprets
// the paired non-null arg as LOSS even though a WIN was constructed.
//
// Observed VM output: ["LOSS"] (1 log)
// Expected output:     ["WIN", "9"] (2 logs)

type Win = { tag: true; value: UdonInt };
type Loss = { tag: false };
type Result = Win | Loss;

class M {
  private selectBest(a: Result | null, b: Result | null): Result {
    if (a?.tag && b !== null && b.tag) {
      return (a.value as number) >= (b.value as number) ? a : b;
    }
    if (a?.tag) return a;
    if (b?.tag) return b;
    return { tag: false };
  }

  run(v: UdonInt): Result {
    const win: Win = { tag: true, value: v };
    return this.selectBest(win, null);
  }
}

@UdonBehaviour()
export class Pr170UnionWithNullBranch extends UdonSharpBehaviour {
  Start(): void {
    const m = new M();
    const r = m.run(UdonTypeConverters.toUdonInt(9));
    Debug.Log(r.tag ? "WIN" : "LOSS");
    if (r.tag) {
      Debug.Log(r.value as number); // 9
    }
  }
}
