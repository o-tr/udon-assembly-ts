import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class BooleanChainPrecedenceTest extends UdonSharpBehaviour {
  Start(): void {
    const a = true;
    const b = false;
    const c = true;

    const result = (a && b) || (c && (a || b));
    Debug.Log(result);
  }
}
