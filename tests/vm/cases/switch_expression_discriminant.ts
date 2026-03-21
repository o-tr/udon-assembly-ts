import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class SwitchExpressionDiscriminant extends UdonSharpBehaviour {
  private callCount: UdonInt = 0 as UdonInt;

  compute(): UdonInt {
    this.callCount = (this.callCount + 1) as UdonInt;
    return 3 as UdonInt;
  }

  Start(): void {
    // Switch on computed expression
    const a: UdonInt = 2 as UdonInt;
    const b: UdonInt = 3 as UdonInt;
    switch (a + b) {
      case 5:
        Debug.Log("matched 5");
        break;
      case 4:
        Debug.Log("matched 4");
        break;
      default:
        Debug.Log("default");
        break;
    }

    // Switch on method call
    switch (this.compute()) {
      case 3:
        Debug.Log("computed match");
        break;
      default:
        Debug.Log("no match");
        break;
    }

    // Verify compute() was called exactly once
    Debug.Log(this.callCount);
  }
}
