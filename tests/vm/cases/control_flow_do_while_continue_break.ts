import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ControlFlowDoWhileContinueBreak extends UdonSharpBehaviour {
  Start(): void {
    let i = 0;
    let total = 0;

    do {
      i += 1;
      if (i === 2) {
        continue;
      }
      if (i === 5) {
        break;
      }
      total += i;
    } while (i < 10);

    Debug.Log(total);
  }
}
