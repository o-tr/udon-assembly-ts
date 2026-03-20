import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class IntArithmetic extends UdonSharpBehaviour {
  Start(): void {
    // Integer division truncates toward zero
    const a: UdonInt = 7 as UdonInt;
    const b: UdonInt = 2 as UdonInt;
    const div: UdonInt = (a / b) as UdonInt;
    Debug.Log(div); // 3 (integer division)

    // Integer modulo
    const mod: UdonInt = (a % b) as UdonInt;
    Debug.Log(mod); // 1

    // Negative integer division truncates toward zero
    const c: UdonInt = -7 as UdonInt;
    const negDiv: UdonInt = (c / b) as UdonInt;
    Debug.Log(negDiv); // -3

    // Integer multiplication
    const mul: UdonInt = (a * b) as UdonInt;
    Debug.Log(mul); // 14

    // Integer addition and subtraction
    const sum: UdonInt = (a + b) as UdonInt;
    Debug.Log(sum); // 9
    const diff: UdonInt = (a - b) as UdonInt;
    Debug.Log(diff); // 5
  }
}
