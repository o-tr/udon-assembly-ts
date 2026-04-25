import { Convert } from "@ootr/udon-assembly-ts/stubs/SystemTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonLong } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class RestrictedTypeDefaultLong extends UdonSharpBehaviour {
  private zeroLong: UdonLong = 0n as UdonLong;

  Start(): void {
    Debug.Log(Convert.ToInt32(this.zeroLong));
  }
}
