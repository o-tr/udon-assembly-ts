import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class OperatorsComparison extends UdonSharpBehaviour {
  Start(): void {
    if (5 == 5) { Debug.Log("eq"); }
    if (5 != 3) { Debug.Log("neq"); }
    if (3 < 5) { Debug.Log("lt"); }
    if (5 > 3) { Debug.Log("gt"); }
    if (5 <= 5) { Debug.Log("lte"); }
    if (5 >= 5) { Debug.Log("gte"); }
    if (!false) { Debug.Log("not"); }
  }
}
