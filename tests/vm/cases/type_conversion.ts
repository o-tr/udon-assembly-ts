import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class TypeConversion extends UdonSharpBehaviour {
  Start(): void {
    const a: number = 3.14;
    Debug.Log(a);
    const b: number = 100;
    Debug.Log(b);
    const c: number = 0 - 42;
    Debug.Log(c);
    const d: boolean = true;
    Debug.Log(d);
    const e: boolean = false;
    Debug.Log(e);
  }
}
