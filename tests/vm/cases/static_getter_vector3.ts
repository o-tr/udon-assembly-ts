import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug, Vector3 } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class StaticGetterVector3 extends UdonSharpBehaviour {
  Start(): void {
    const v: Vector3 = Vector3.zero;
    Debug.Log(v);
  }
}
