import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ForOfContinueBreakMix extends UdonSharpBehaviour {
  Start(): void {
    const values = [1, 2, 3, 4, 5];
    let sum: UdonInt = 0 as UdonInt;

    for (const value of values) {
      if (value === 2) {
        continue;
      }
      if (value === 5) {
        break;
      }
      sum = (sum + (value as UdonInt)) as UdonInt;
    }

    Debug.Log(sum);
  }
}
