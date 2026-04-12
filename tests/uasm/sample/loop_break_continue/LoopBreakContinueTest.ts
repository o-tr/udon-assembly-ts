import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class LoopBreakContinueTest extends UdonSharpBehaviour {
  Start(): void {
    let sum: UdonInt = 0 as UdonInt;

    for (let i: UdonInt = 0 as UdonInt; i < (8 as UdonInt); i++) {
      if (i === (2 as UdonInt)) {
        continue;
      }
      if (i === (6 as UdonInt)) {
        break;
      }
      sum = (sum + i) as UdonInt;
    }

    Debug.Log(sum);
  }
}
