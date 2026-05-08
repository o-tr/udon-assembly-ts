import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class LoopBreakContinueTest extends UdonSharpBehaviour {
  Start(): void {
    let sum: UdonInt = 0n as UdonInt;

    for (let i: UdonInt = 0n as UdonInt; i < (8n as UdonInt); i++) {
      if (i === (2n as UdonInt)) {
        continue;
      }
      if (i === (6n as UdonInt)) {
        break;
      }
      sum = (sum + i) as UdonInt;
    }

    Debug.Log(sum);
  }
}
