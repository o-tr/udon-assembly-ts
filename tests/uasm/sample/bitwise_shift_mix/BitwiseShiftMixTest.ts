import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class BitwiseShiftMixTest extends UdonSharpBehaviour {
  Start(): void {
    const value: UdonInt = 42 as UdonInt;
    const mask: UdonInt = 15 as UdonInt;

    const andValue: UdonInt = (value & mask) as UdonInt;
    const leftShift: UdonInt = (andValue << (1 as UdonInt)) as UdonInt;
    const rightShift: UdonInt = (leftShift >> (2 as UdonInt)) as UdonInt;

    Debug.Log(andValue);
    Debug.Log(leftShift);
    Debug.Log(rightShift);
  }
}
