import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class MixedNumericArithmetic extends UdonSharpBehaviour {
  Start(): void {
    const intVal: UdonInt = 10 as UdonInt;
    const floatVal: number = 1.5;

    // int + float -> float
    const sum: number = intVal + floatVal;
    Debug.Log(sum); // 11.5

    // int * float -> float
    const product: number = intVal * 2.0;
    Debug.Log(product); // 20.0 → "20"

    // float / int -> float
    const divided: number = 7.5 / intVal;
    Debug.Log(divided); // 0.75

    // Chained mixed: (int + float) * int → (10 + 1.5) * 2 = 23
    const chained: number = (intVal + floatVal) * 2;
    Debug.Log(chained); // 23
  }
}
