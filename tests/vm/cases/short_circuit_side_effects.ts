import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ShortCircuitSideEffects extends UdonSharpBehaviour {
  checkFalse(): boolean {
    Debug.Log("check-a");
    return false;
  }

  checkTrue(): boolean {
    Debug.Log("check-b");
    return true;
  }

  sideEffect(): boolean {
    Debug.Log("side-effect");
    return true;
  }

  Start(): void {
    // && short-circuit: left is false -> right should NOT be called
    const andResult: boolean = this.checkFalse() && this.sideEffect();
    Debug.Log(andResult); // False

    // || short-circuit: left is true -> right should NOT be called
    const orResult: boolean = this.checkTrue() || this.sideEffect();
    Debug.Log(orResult); // True
  }
}
