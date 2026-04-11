import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class DiamondSimpTest extends UdonSharpBehaviour {
  private score: UdonInt = 0 as UdonInt;

  Start(): void {
    this.score = 75 as UdonInt;
    const passed: boolean = this.score >= (60 as UdonInt) ? true : false;
    const failed: boolean = this.score < (60 as UdonInt) ? true : false;
    Debug.Log(passed);
    Debug.Log(failed);
  }
}
