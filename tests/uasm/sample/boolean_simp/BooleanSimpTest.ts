import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class BooleanSimpTest extends UdonSharpBehaviour {
  Start(): void {
    const flag = true as boolean;
    const a: boolean = flag && true;
    const b: boolean = flag || false;
    const c: boolean = !(flag === (false as boolean));
    Debug.Log(a);
    Debug.Log(b);
    Debug.Log(c);
  }
}
