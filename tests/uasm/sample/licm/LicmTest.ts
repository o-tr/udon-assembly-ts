import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class LicmTest extends UdonSharpBehaviour {
  Start(): void {
    const baseVal: UdonInt = 10n as UdonInt;
    const mult: UdonInt = 3n as UdonInt;
    let sum: UdonInt = 0n as UdonInt;
    for (let i: UdonInt = 0n as UdonInt; i < (5n as UdonInt); i++) {
      const invariant: UdonInt = (baseVal * mult) as UdonInt;
      sum = (sum + invariant) as UdonInt;
    }
    Debug.Log(sum);
  }
}
