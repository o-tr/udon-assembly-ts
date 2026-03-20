import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonFloat } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug, Mathf } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class MathfBasic extends UdonSharpBehaviour {
  Start(): void {
    Debug.Log(Mathf.Abs(-5 as UdonFloat));
    Debug.Log(Mathf.Min(3 as UdonFloat, 7 as UdonFloat));
    Debug.Log(Mathf.Max(3 as UdonFloat, 7 as UdonFloat));
    Debug.Log(Mathf.Floor(3.75 as UdonFloat));
    Debug.Log(Mathf.Ceil(3.25 as UdonFloat));
  }
}
