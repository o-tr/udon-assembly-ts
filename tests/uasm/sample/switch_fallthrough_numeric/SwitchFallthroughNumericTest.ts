import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class SwitchFallthroughNumericTest extends UdonSharpBehaviour {
  Start(): void {
    const value: number = 2;
    let label = "";

    switch (value) {
      case 0:
        label = "zero";
        break;
      case 1:
      case 2:
        label = "small";
        break;
      default:
        label = "other";
        break;
    }

    Debug.Log(label);
  }
}
