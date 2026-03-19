import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class BooleanCoercionNot extends UdonSharpBehaviour {
  Start(): void {
    // !true → false (Boolean, no coercion needed)
    const a: boolean = !true;
    Debug.Log(a); // False

    // !false → true
    const b: boolean = !false;
    Debug.Log(b); // True

    // Double negation
    const c: boolean = !!true;
    Debug.Log(c); // True

    // Boolean in conditional
    const val: boolean = true;
    if (!val) {
      Debug.Log("unreachable");
    } else {
      Debug.Log("correct");
    }
    // Expected: "correct"
  }
}
