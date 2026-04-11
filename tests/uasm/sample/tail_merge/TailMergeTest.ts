import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class TailMergeTest extends UdonSharpBehaviour {
  private mode: UdonInt = 0 as UdonInt;

  Start(): void {
    this.mode = 1 as UdonInt;
    if (this.mode == (1 as UdonInt)) {
      Debug.Log("mode one");
    } else if (this.mode == (2 as UdonInt)) {
      Debug.Log("mode two");
    } else {
      Debug.Log("other");
    }
  }
}
