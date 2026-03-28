import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

// Tests Fix D-3: when a variable has an interface type (IYaku) but is obtained
// via a ternary expression (losing per-instance tracking), the untracked handle
// dispatch in visitPropertyAccessExpression must match concrete implementors
// (BasicYaku / SpecialYaku) even though untrackedTypeName is "IYaku".
// Before the fix, allInlineInstances entries with className="BasicYaku" were
// not matched because the filter only compared className against the interface
// name, so dispInstances was empty and property access fell through to EXTERN.

interface IYaku {
  points: number;
  label: string;
}

class BasicYaku implements IYaku {
  points: number;
  label: string;
  constructor(pts: number, lbl: string) {
    this.points = pts;
    this.label = lbl;
  }
}

class SpecialYaku implements IYaku {
  points: number;
  label: string;
  constructor(pts: number, lbl: string) {
    this.points = pts;
    this.label = lbl;
  }
}

@UdonBehaviour()
export class InterfaceUntrackedDispatch extends UdonSharpBehaviour {
  private b: BasicYaku = new BasicYaku(1, "basic");
  private s: SpecialYaku = new SpecialYaku(3, "special");
  private flag: boolean = true;

  Start(): void {
    // Ternary returns IYaku — tracking is lost after the join point, making
    // yaku an untracked IYaku-typed handle. D-3 dispatch must resolve it.
    const yaku: IYaku = this.flag ? this.b : this.s;
    Debug.Log(yaku.points); // 1
    Debug.Log(yaku.label); // basic

    this.flag = false;
    const yaku2: IYaku = this.flag ? this.b : this.s;
    Debug.Log(yaku2.points); // 3
    Debug.Log(yaku2.label); // special
  }
}
