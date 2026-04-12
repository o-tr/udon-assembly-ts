import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class EarlyReturnGuardTest extends UdonSharpBehaviour {
  private isReady = false;

  Start(): void {
    if (!this.isReady) {
      Debug.Log("skip");
      return;
    }

    Debug.Log("run");
  }
}
