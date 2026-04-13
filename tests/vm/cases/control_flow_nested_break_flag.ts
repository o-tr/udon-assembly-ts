import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ControlFlowNestedBreakFlag extends UdonSharpBehaviour {
  Start(): void {
    let sum = 0;
    let stop = false;

    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        if (i + j > 4) {
          stop = true;
          break;
        }
        if (j === 1) {
          continue;
        }
        sum += i + j;
      }

      if (stop) {
        break;
      }
    }

    Debug.Log(sum);
  }
}
