import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class SwitchFallthrough extends UdonSharpBehaviour {
  Start(): void {
    // Fall-through: case 1 without break falls into case 2
    const a: number = 1;
    switch (a) {
      // biome-ignore lint/suspicious/noFallthroughSwitchClause: intentional fall-through test
      case 1:
        Debug.Log("one");
      // no break - falls through to case 2
      case 2:
        Debug.Log("two");
        break;
      case 3:
        Debug.Log("three");
        break;
    }
    // Expected: "one", "two"

    // Normal break behavior for comparison
    const b: number = 2;
    switch (b) {
      case 1:
        Debug.Log("b-one");
        break;
      case 2:
        Debug.Log("b-two");
        break;
    }
    // Expected: "b-two"

    // Default case only (no case matches)
    const c: number = 99;
    switch (c) {
      case 1:
        Debug.Log("c-one");
        break;
      default:
        Debug.Log("c-default");
        break;
    }
    // Expected: "c-default"
  }
}
