import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class TryCatchFinally extends UdonSharpBehaviour {
  Start(): void {
    // Case 1: try succeeds, finally runs
    try {
      Debug.Log("try-ok");
    } catch (_e) {
      Debug.Log("caught-1");
    } finally {
      Debug.Log("finally-1");
    }

    // Case 2: try throws, catch runs, finally runs
    try {
      throw new Error("fail");
    } catch (_e) {
      Debug.Log("caught-2");
    } finally {
      Debug.Log("finally-2");
    }

    Debug.Log("done");
  }
}
