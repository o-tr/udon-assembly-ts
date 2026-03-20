import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class LoopVariableScoping extends UdonSharpBehaviour {
  Start(): void {
    // First loop with variable 'i'
    for (
      let i: UdonInt = 0 as UdonInt;
      i < (3 as UdonInt);
      i = (i + 1) as UdonInt
    ) {
      Debug.Log(i);
    }
    // Expected: 0, 1, 2

    // Second loop reusing 'i' - should start fresh
    for (
      let i: UdonInt = 10 as UdonInt;
      i < (13 as UdonInt);
      i = (i + 1) as UdonInt
    ) {
      Debug.Log(i);
    }
    // Expected: 10, 11, 12
  }
}
