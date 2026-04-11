import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class GvnPreTest extends UdonSharpBehaviour {
  Start(): void {
    const x: UdonInt = 10 as UdonInt;
    const y: UdonInt = 20 as UdonInt;
    const a: UdonInt = (x + y) as UdonInt;
    const b: UdonInt = (x + y) as UdonInt;
    Debug.Log(a);
    Debug.Log(b);
  }
}
