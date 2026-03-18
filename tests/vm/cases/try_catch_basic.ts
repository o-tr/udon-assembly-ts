import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class TryCatchBasic extends UdonSharpBehaviour {
  Start(): void {
    try {
      Debug.Log("before");
      Debug.Log("after");
    } catch (e) {
      Debug.Log("error");
    }
  }
}
