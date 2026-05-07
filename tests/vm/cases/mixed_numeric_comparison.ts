import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class MixedNumericComparison extends UdonSharpBehaviour {
  Start(): void {
    const intVal: UdonInt = 3n as UdonInt;
    const floatVal: number = 3.0;
    const floatVal2: number = 3.25;

    // int == float (equal)
    Debug.Log(Number(intVal) === floatVal); // True

    // int < float
    Debug.Log(Number(intVal) < floatVal2); // True

    // int > float
    Debug.Log(Number(intVal) > floatVal2); // False

    // int >= float (equal values)
    Debug.Log(Number(intVal) >= floatVal); // True
  }
}
