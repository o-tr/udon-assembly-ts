import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class DeadCodeTest extends UdonSharpBehaviour {
  Start(): void {
    const x: UdonInt = 10 as UdonInt;
    const y: UdonInt = 20 as UdonInt;
    const z: UdonInt = (x + y) as UdonInt;
    const w: UdonInt = (x * (2 as UdonInt)) as UdonInt;
    Debug.Log(w);
    return;
    Debug.Log("unreachable");
  }
}
