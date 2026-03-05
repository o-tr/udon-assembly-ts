import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ComplexBoolean extends UdonSharpBehaviour {
  Start(): void {
    const a: boolean = true;
    const b: boolean = false;
    const c: boolean = true;
    Debug.Log((a && b) || c);
    Debug.Log((a || b) && !c);
    Debug.Log(!a || (b && c));
    const x: number = 5;
    const y: number = 10;
    Debug.Log(x > 3 && y < 20);
    Debug.Log(x > 10 || y > 5);
    Debug.Log(!(x > 3) && y > 5);
  }
}
