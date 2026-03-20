import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class TryCatchNested extends UdonSharpBehaviour {
  Start(): void {
    try {
      Debug.Log("outer-start");
      try {
        Debug.Log("inner-start");
        throw new Error("inner error");
      } catch (_e) {
        Debug.Log("inner-caught");
      }
      Debug.Log("outer-continues");
    } catch (_e) {
      Debug.Log("outer-caught");
    }
    Debug.Log("done");
  }
}
