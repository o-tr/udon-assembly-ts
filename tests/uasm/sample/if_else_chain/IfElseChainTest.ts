import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class IfElseChainTest extends UdonSharpBehaviour {
  Start(): void {
    const x: UdonInt = 5n as UdonInt;
    let result: UdonInt = 0n as UdonInt;
    if (x > (10n as UdonInt)) {
      result = 1n as UdonInt;
    } else if (x > (3n as UdonInt)) {
      result = 2n as UdonInt;
    } else {
      result = 3n as UdonInt;
    }
    Debug.Log(result);
  }
}
