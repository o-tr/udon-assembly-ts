import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class LargeFloatLiteral extends UdonSharpBehaviour {
  Start(): void {
    // Large float constant (10-digit integer part, triggers runtime Single.Parse)
    const big: number = 9999999999;
    const small: number = 1;

    // Verify the large constant was correctly initialized via comparison
    const isGreater: boolean = big > small;
    Debug.Log(isGreater); // True

    // Use a value that stays distinct even in Single precision
    // Single has ~7 significant digits, so 1234567 vs 1234568 are distinct
    const valA: number = 1234567.0;
    const valB: number = 1234568.0;
    const isDifferent: boolean = valB > valA;
    Debug.Log(isDifferent); // True
  }
}
