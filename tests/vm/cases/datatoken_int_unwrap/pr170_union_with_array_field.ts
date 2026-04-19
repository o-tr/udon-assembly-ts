import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import {
  type UdonInt,
  UdonTypeConverters,
} from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

// PR #170 residual regression: discriminated union where WIN branch has an
// array field absent from LOSS branch. PR #170 merges compatible union
// branches into a synthetic `__anon_union` InterfaceTypeSymbol, but when
// one branch carries a field the other does not (here: `list: string[]`
// only in Win), the VM takes the LOSS branch even though a WIN object was
// constructed — silent control-flow divergence.
//
// Observed VM output: ["LOSS"] (1 log)
// Expected output:     ["WIN", "11", "2"] (3 logs)

type Win = {
  tag: true;
  value: UdonInt;
  list: string[];
};
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

  compute(v: UdonInt): Result {
    const win: Win = { tag: true, value: v, list: ["alpha", "beta"] };
    return this.selectBest(win, { tag: false });
  }
}

@UdonBehaviour()
export class Pr170UnionWithArrayField extends UdonSharpBehaviour {
  Start(): void {
    const m = new M();
    const r = m.compute(UdonTypeConverters.toUdonInt(11));
    Debug.Log(r.tag ? "WIN" : "LOSS");
    if (r.tag) {
      Debug.Log(r.value as number); // 11
      Debug.Log(r.list.length); // 2
    }
  }
}
