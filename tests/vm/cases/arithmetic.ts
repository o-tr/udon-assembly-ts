import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class Arithmetic extends UdonSharpBehaviour {
  Start(): void {
    const a: number = 10;
    const b: number = 5;
    Debug.Log(a + b);
    Debug.Log(a - b);
    Debug.Log(a * b);
    Debug.Log(a / b);
  }
}
