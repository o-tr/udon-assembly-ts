import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ConstantFoldTest extends UdonSharpBehaviour {
  Start(): void {
    const a: UdonInt = ((2 as UdonInt) + (3 as UdonInt)) as UdonInt;
    const b: UdonInt = (a * (4 as UdonInt)) as UdonInt;
    const c: UdonInt = ((100 as UdonInt) / (5 as UdonInt)) as UdonInt;
    const d: UdonInt = (b + c) as UdonInt;
    Debug.Log(d);
  }
}
