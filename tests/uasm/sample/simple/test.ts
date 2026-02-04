import { UdonSharpBehaviour } from "udon-assembly-ts/stubs/UdonSharpBehaviour";
import { UdonBehaviour } from "udon-assembly-ts/stubs/UdonDecorators";
import { Debug } from "udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class UdonSharpTest extends UdonSharpBehaviour {
  Start(): void {
    Debug.Log("hello udon-sharp");
  }
}
