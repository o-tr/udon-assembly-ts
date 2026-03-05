import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug, Mathf } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class MathfAdvanced extends UdonSharpBehaviour {
  Start(): void {
    Debug.Log(Mathf.Sqrt(9));
    Debug.Log(Mathf.Pow(2, 10));
    const rounded: number = Mathf.Round(3.5);
    Debug.Log(rounded);
  }
}
