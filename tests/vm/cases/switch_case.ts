import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class SwitchCase extends UdonSharpBehaviour {
  Start(): void {
    let val: number = 2;
    switch (val) {
      case 1:
        Debug.Log("one");
        break;
      case 2:
        Debug.Log("two");
        break;
      case 3:
        Debug.Log("three");
        break;
    }

    val = 99;
    switch (val) {
      case 1:
        Debug.Log("one");
        break;
      default:
        Debug.Log("default");
        break;
    }
  }
}
