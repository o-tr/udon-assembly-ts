import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class RestrictedTypeInit extends UdonSharpBehaviour {
  Start(): void {
    // Boolean true constant: lowered to null + runtime init via (0 == 0)
    const boolTrue: boolean = true;
    Debug.Log(boolTrue); // True

    // Boolean false constant: lowered to null (default value)
    const boolFalse: boolean = false;
    Debug.Log(boolFalse); // False

    // Use the constants in an expression to verify they are correct
    const result: boolean = boolTrue && !boolFalse;
    Debug.Log(result); // True
  }
}
