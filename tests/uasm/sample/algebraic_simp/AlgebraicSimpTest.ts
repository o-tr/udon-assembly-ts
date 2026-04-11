import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class AlgebraicSimpTest extends UdonSharpBehaviour {
  private value: UdonInt = 0 as UdonInt;

  Start(): void {
    this.value = 10 as UdonInt;
    const a: UdonInt = (this.value + (0 as UdonInt)) as UdonInt;
    const b: UdonInt = (this.value * (1 as UdonInt)) as UdonInt;
    const c: UdonInt = (this.value - (0 as UdonInt)) as UdonInt;
    const d: UdonInt = (this.value * (0 as UdonInt)) as UdonInt;
    Debug.Log(a);
    Debug.Log(b);
    Debug.Log(c);
    Debug.Log(d);
  }
}
