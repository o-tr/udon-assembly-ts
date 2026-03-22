import { Convert } from "@ootr/udon-assembly-ts/stubs/SystemTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt, UdonLong } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class LongFieldInit extends UdonSharpBehaviour {
  private posLong: UdonLong = 100n as UdonLong;
  private negLong: UdonLong = -50n as UdonLong;
  private zeroLong: UdonLong = 0n as UdonLong;

  Start(): void {
    // Int32 range Int64 fields should be correctly initialized
    const posInt: UdonInt = Convert.ToInt32(this.posLong);
    Debug.Log(posInt); // "100"

    const negInt: UdonInt = Convert.ToInt32(this.negLong);
    Debug.Log(negInt); // "-50"

    const zeroInt: UdonInt = Convert.ToInt32(this.zeroLong);
    Debug.Log(zeroInt); // "0"

    // Verify arithmetic via Int32 conversion
    const sumInt: UdonInt = (Convert.ToInt32(this.posLong) +
      Convert.ToInt32(this.negLong)) as UdonInt;
    Debug.Log(sumInt); // "50"
  }
}
