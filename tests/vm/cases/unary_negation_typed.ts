import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class UnaryNegationTyped extends UdonSharpBehaviour {
  Start(): void {
    // Unary negation on UdonInt constant
    const a: UdonInt = -10 as UdonInt;
    Debug.Log(a); // -10

    // Unary negation on UdonInt variable
    const x: UdonInt = 42 as UdonInt;
    const negX: UdonInt = -x as UdonInt;
    Debug.Log(negX); // -42

    // Double negation restores original value
    const doubleNeg: UdonInt = -negX as UdonInt;
    Debug.Log(doubleNeg); // 42
  }
}
