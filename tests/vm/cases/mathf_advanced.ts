import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonFloat } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug, Mathf } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class MathfAdvanced extends UdonSharpBehaviour {
  Start(): void {
    Debug.Log(Mathf.Sqrt(9 as UdonFloat));
    Debug.Log(Mathf.Pow(2 as UdonFloat, 10 as UdonFloat));
    const rounded: number = Mathf.Round(3.5 as UdonFloat);
    Debug.Log(rounded);
  }
}
