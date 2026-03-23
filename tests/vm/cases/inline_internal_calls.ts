import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

/**
 * Regression test for WS-1: inline class standalone code block elimination.
 *
 * Before the fix, Helper's standalone code block was generated, and
 * this.shared() inside it became an unresolvable EXTERN, crashing the VM.
 * After the fix, Helper is only inlined at call sites — no standalone block.
 */
class Helper {
  methodA(): number {
    return this.shared() + 1;
  }

  methodB(): number {
    return this.shared() * 2;
  }

  private shared(): number {
    return 10;
  }
}

@UdonBehaviour()
export class InlineInternalCalls extends UdonSharpBehaviour {
  private helper: Helper = new Helper();

  Start(): void {
    Debug.Log(this.helper.methodA());
    Debug.Log(this.helper.methodB());
  }
}
