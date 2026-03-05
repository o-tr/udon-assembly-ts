import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug, Mathf } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class MathfBasic extends UdonSharpBehaviour {
  Start(): void {
    Debug.Log(Mathf.Abs(-5));
    Debug.Log(Mathf.Min(3, 7));
    Debug.Log(Mathf.Max(3, 7));
    Debug.Log(Mathf.Floor(3.7));
    Debug.Log(Mathf.Ceil(3.2));
  }
}
