import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class SwitchString extends UdonSharpBehaviour {
  Start(): void {
    // String switch
    const cmd: string = "hello";
    switch (cmd) {
      case "world":
        Debug.Log("matched world");
        break;
      case "hello":
        Debug.Log("matched hello");
        break;
      default:
        Debug.Log("no match");
        break;
    }
    // Expected: "matched hello"

    // String switch with default
    const cmd2: string = "unknown";
    switch (cmd2) {
      case "a":
        Debug.Log("matched a");
        break;
      case "b":
        Debug.Log("matched b");
        break;
      default:
        Debug.Log("default");
        break;
    }
    // Expected: "default"
  }
}
