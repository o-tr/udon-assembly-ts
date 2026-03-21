import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ShortcircuitSideEffects extends UdonSharpBehaviour {
  sideEffects: number = 0;

  bump(): boolean {
    this.sideEffects = this.sideEffects + 1;
    return true;
  }

  Start(): void {
    const andSkipped: boolean = false && this.bump();
    Debug.Log(andSkipped);
    Debug.Log(this.sideEffects);

    const orSkipped: boolean = true || this.bump();
    Debug.Log(orSkipped);
    Debug.Log(this.sideEffects);

    const andExecuted: boolean = true && this.bump();
    Debug.Log(andExecuted);
    Debug.Log(this.sideEffects);

    const orExecuted: boolean = false || this.bump();
    Debug.Log(orExecuted);
    Debug.Log(this.sideEffects);
  }
}
