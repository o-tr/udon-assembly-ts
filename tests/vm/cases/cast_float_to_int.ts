import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import {
  type UdonInt,
  UdonTypeConverters,
} from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class CastFloatToInt extends UdonSharpBehaviour {
  Start(): void {
    // Cast float to int via CastInstruction (Single→Int32, truncation toward zero)
    const a: number = 3.75;
    const intA: UdonInt = UdonTypeConverters.truncToUdonInt(a);
    Debug.Log(intA); // 3

    // Negative truncation toward zero
    const b: number = -3.75;
    const intB: UdonInt = UdonTypeConverters.truncToUdonInt(b);
    Debug.Log(intB); // -3

    // Value less than 1 truncates to 0
    const c: number = 0.75;
    const intC: UdonInt = UdonTypeConverters.truncToUdonInt(c);
    Debug.Log(intC); // 0

    // Whole float converts cleanly
    const d: number = 100.0;
    const intD: UdonInt = UdonTypeConverters.truncToUdonInt(d);
    Debug.Log(intD); // 100
  }
}
