import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ForLoopBreakContinue extends UdonSharpBehaviour {
  Start(): void {
    // Skip even numbers with continue, break at 7
    for (
      let i: UdonInt = 0 as UdonInt;
      i < (10 as UdonInt);
      i = (i + 1) as UdonInt
    ) {
      if (i % (2 as UdonInt) === (0 as UdonInt)) {
        continue;
      }
      if (i > (6 as UdonInt)) {
        break;
      }
      Debug.Log(i);
    }
    // Expected: 1, 3, 5

    // Nested loops: break only inner
    for (
      let i: UdonInt = 0 as UdonInt;
      i < (2 as UdonInt);
      i = (i + 1) as UdonInt
    ) {
      for (
        let j: UdonInt = 0 as UdonInt;
        j < (5 as UdonInt);
        j = (j + 1) as UdonInt
      ) {
        if (j > (1 as UdonInt)) {
          break;
        }
        Debug.Log(j);
      }
    }
    // Expected: 0, 1, 0, 1
  }
}
