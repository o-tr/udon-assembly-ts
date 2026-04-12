import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class NestedIfMergeTest extends UdonSharpBehaviour {
  Start(): void {
    const score = 9;
    const lives = 1;

    let result = "";
    if (score > 10) {
      result = "clear";
    } else if (lives > 0) {
      result = "retry";
    } else {
      result = "fail";
    }

    Debug.Log(result);
  }
}
