import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class MixedNumericArithmetic extends UdonSharpBehaviour {
  Start(): void {
    const intVal: UdonInt = 10n as UdonInt;
    const floatVal: number = 1.5;

    // int + float -> float
    const sum: number = Number(intVal) + floatVal;
    Debug.Log(sum); // 11.5

    // int * float -> float
    const product: number = Number(intVal) * 2.0;
    Debug.Log(product); // 20.0 → "20"

    // float / int -> float
    const divided: number = 7.5 / Number(intVal);
    Debug.Log(divided); // 0.75

    // Chained mixed: (Int32 + Single) * Single → Single: (10 + 1.5) * 2.0 = 23.0 → "23"
    const chained: number = (Number(intVal) + floatVal) * 2;
    Debug.Log(chained); // 23
  }
}
