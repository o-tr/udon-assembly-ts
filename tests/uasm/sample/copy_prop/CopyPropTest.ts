import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class CopyPropTest extends UdonSharpBehaviour {
  Start(): void {
    const a: UdonInt = 5 as UdonInt;
    const b: UdonInt = a;
    const c: UdonInt = b;
    const d: UdonInt = (c + (1 as UdonInt)) as UdonInt;
    Debug.Log(d);
  }
}
