import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class BooleanToStringFormat extends UdonSharpBehaviour {
  Start(): void {
    Debug.Log(true);
    Debug.Log(false);
    const gt: boolean = 1 > 0;
    Debug.Log(gt);
    const lt: boolean = 1 < 0;
    Debug.Log(lt);
  }
}
