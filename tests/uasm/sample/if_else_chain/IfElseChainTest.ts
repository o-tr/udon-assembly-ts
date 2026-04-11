import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class IfElseChainTest extends UdonSharpBehaviour {
  Start(): void {
    const x: UdonInt = 5 as UdonInt;
    let result: UdonInt = 0 as UdonInt;
    if (x > (10 as UdonInt)) {
      result = 1 as UdonInt;
    } else if (x > (3 as UdonInt)) {
      result = 2 as UdonInt;
    } else {
      result = 3 as UdonInt;
    }
    Debug.Log(result);
  }
}
