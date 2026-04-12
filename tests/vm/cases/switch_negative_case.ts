import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class SwitchNegativeCase extends UdonSharpBehaviour {
  Start(): void {
    const value = -1;
    let label = "";

    switch (value) {
      case -1:
        label = "minus";
        break;
      case 0:
        label = "zero";
        break;
      default:
        label = "other";
        break;
    }

    Debug.Log(label);
  }
}
