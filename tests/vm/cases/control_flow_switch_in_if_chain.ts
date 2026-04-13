import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ControlFlowSwitchInIfChain extends UdonSharpBehaviour {
  Start(): void {
    const mode: number = 2;
    const level: number = 1;
    let result = -1;

    if (level > 0) {
      switch (mode) {
        case 1:
          result = 10;
          break;
        case 2:
          result = 20;
          break;
        default:
          result = 5;
          break;
      }
    } else {
      result = -100;
    }

    Debug.Log(result);
  }
}
