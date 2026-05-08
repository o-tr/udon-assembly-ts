import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class LoopUnrollTest extends UdonSharpBehaviour {
  Start(): void {
    let sum: UdonInt = 0n as UdonInt;
    for (let i: UdonInt = 0n as UdonInt; i < (3n as UdonInt); i++) {
      sum = (sum + i) as UdonInt;
    }
    Debug.Log(sum);
  }
}
