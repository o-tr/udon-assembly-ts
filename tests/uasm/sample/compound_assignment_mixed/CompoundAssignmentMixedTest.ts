import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class CompoundAssignmentMixedTest extends UdonSharpBehaviour {
  Start(): void {
    let total = 10;
    let ratio = 1.5;

    total += 4;
    ratio *= 2;
    ratio += total;

    Debug.Log(total);
    Debug.Log(ratio);
  }
}
