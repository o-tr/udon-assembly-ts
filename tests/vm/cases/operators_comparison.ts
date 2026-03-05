import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class OperatorsComparison extends UdonSharpBehaviour {
  Start(): void {
    const a: number = 5;
    const b: number = 3;
    const c: number = 5;
    if (a === c) {
      Debug.Log("eq");
    }
    if (a !== b) {
      Debug.Log("neq");
    }
    if (b < a) {
      Debug.Log("lt");
    }
    if (a > b) {
      Debug.Log("gt");
    }
    if (a <= c) {
      Debug.Log("lte");
    }
    if (a >= c) {
      Debug.Log("gte");
    }
    const f: boolean = false;
    if (!f) {
      Debug.Log("not");
    }
  }
}
