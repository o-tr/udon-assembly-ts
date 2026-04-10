import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";

@UdonBehaviour()
export class FibonacciTest extends UdonSharpBehaviour {
  Start(): void {
    let a: UdonInt = 0 as UdonInt;
    let b: UdonInt = 1 as UdonInt;
    for (let i: UdonInt = 0 as UdonInt; i < (10 as UdonInt); i++) {
      Debug.Log(a);
      const temp: UdonInt = (a + b) as UdonInt;
      a = b;
      b = temp;
    }
  }
}
