import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class NegativeNumbers extends UdonSharpBehaviour {
  Start(): void {
    const a: number = -5;
    Debug.Log(a);
    const b: number = a * 2;
    Debug.Log(b);
    const c: number = -a;
    Debug.Log(c);
    const d: number = -1;
    Debug.Log(d);
  }
}
