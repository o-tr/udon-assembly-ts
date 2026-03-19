import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class CompoundAssignmentMixed extends UdonSharpBehaviour {
  Start(): void {
    // Integer division: 7 / 2 = 3 (not 3.5)
    let a: UdonInt = 7 as UdonInt;
    a = (a / (2 as UdonInt)) as UdonInt;
    Debug.Log(a); // 3

    // Accumulate with integer operations
    let sum: UdonInt = 0 as UdonInt;
    let i: UdonInt = 1 as UdonInt;
    while (i <= (10 as UdonInt)) {
      sum = (sum + i) as UdonInt;
      i = (i + (1 as UdonInt)) as UdonInt;
    }
    Debug.Log(sum); // 55

    // Integer modulo chain
    let val: UdonInt = 100 as UdonInt;
    val = (val % (7 as UdonInt)) as UdonInt; // 100 % 7 = 2
    Debug.Log(val); // 2

    // Float accumulation for comparison
    let fsum: number = 0;
    fsum = fsum + 1.5;
    fsum = fsum + 2.5;
    fsum = fsum + 3.5;
    Debug.Log(fsum); // 7.5
  }
}
