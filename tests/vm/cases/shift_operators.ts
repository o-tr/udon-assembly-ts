import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ShiftOperators extends UdonSharpBehaviour {
  Start(): void {
    // Left shift
    const a: UdonInt = 1 as UdonInt;
    const lshift: UdonInt = (a << (4 as UdonInt)) as UdonInt;
    Debug.Log(lshift); // 16

    // Right shift
    const b: UdonInt = 256 as UdonInt;
    const rshift: UdonInt = (b >> (2 as UdonInt)) as UdonInt;
    Debug.Log(rshift); // 64

    // Arithmetic right shift on negative number
    const c: UdonInt = -16 as UdonInt;
    const negRshift: UdonInt = (c >> (2 as UdonInt)) as UdonInt;
    Debug.Log(negRshift); // -4

    // Left shift larger amount
    const d: UdonInt = 1 as UdonInt;
    const bigShift: UdonInt = (d << (10 as UdonInt)) as UdonInt;
    Debug.Log(bigShift); // 1024
  }
}
