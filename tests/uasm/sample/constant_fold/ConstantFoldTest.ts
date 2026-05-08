import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ConstantFoldTest extends UdonSharpBehaviour {
  Start(): void {
    const a: UdonInt = ((2n as UdonInt) + (3n as UdonInt)) as UdonInt;
    const b: UdonInt = (a * (4n as UdonInt)) as UdonInt;
    const c: UdonInt = ((100n as UdonInt) / (5n as UdonInt)) as UdonInt;
    const d: UdonInt = (b + c) as UdonInt;
    Debug.Log(d);
  }
}
