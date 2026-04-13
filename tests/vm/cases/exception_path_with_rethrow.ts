import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ExceptionPathWithRethrow extends UdonSharpBehaviour {
  private runInner(): void {
    try {
      Debug.Log("inner-begin");
      throw new Error("boom");
    } catch (_e) {
      Debug.Log("inner-catch");
      throw new Error("rethrow");
    }
  }

  Start(): void {
    try {
      this.runInner();
      Debug.Log("after-inner");
    } catch (_e) {
      Debug.Log("outer-catch");
    }
    Debug.Log("done");
  }
}
