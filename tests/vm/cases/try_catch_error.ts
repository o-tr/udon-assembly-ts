import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class TryCatchError extends UdonSharpBehaviour {
  Start(): void {
    try {
      Debug.Log("before");
      throw new Error("fail");
    } catch (_e) {
      Debug.Log("caught");
    }
    Debug.Log("after");
  }
}
