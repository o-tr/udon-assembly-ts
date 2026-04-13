import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class BooleanShortcircuitSideeffectsTest extends UdonSharpBehaviour {
  private counter: UdonInt = 0 as UdonInt;

  private bumpTrue(): boolean {
    this.counter = (this.counter + (1 as UdonInt)) as UdonInt;
    return true;
  }

  private bumpFalse(): boolean {
    this.counter = (this.counter + (1 as UdonInt)) as UdonInt;
    return false;
  }

  Start(): void {
    const first = this.bumpFalse() && this.bumpTrue();
    const second = this.bumpTrue() || this.bumpFalse();

    Debug.Log(this.counter);
    Debug.Log(first);
    Debug.Log(second);
  }
}
