import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class LoopVariableScoping extends UdonSharpBehaviour {
  Start(): void {
    // First loop with variable 'i'
    for (
      let i: UdonInt = 0n as UdonInt;
      i < (3n as UdonInt);
      i = (i + 1n) as UdonInt
    ) {
      Debug.Log(i);
    }
    // Expected: 0, 1, 2

    // Second loop reusing 'i' - should start fresh
    for (
      let i: UdonInt = 10n as UdonInt;
      i < (13n as UdonInt);
      i = (i + 1n) as UdonInt
    ) {
      Debug.Log(i);
    }
    // Expected: 10, 11, 12
  }
}
