import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ArrayLiteralAccumulateReassign extends UdonSharpBehaviour {
  Start(): void {
    const values = [1, 2, 3, 4];
    let total = 0;

    for (const value of values) {
      total += value;
    }

    values[1] = total;
    Debug.Log(values[1]);
    Debug.Log(values[3]);
  }
}
