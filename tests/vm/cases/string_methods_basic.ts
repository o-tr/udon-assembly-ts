import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class StringMethodsBasic extends UdonSharpBehaviour {
  Start(): void {
    const a: string = "Hello";
    const b: string = " ";
    const c: string = "World";
    const text: string = a + b + c;
    Debug.Log(text);
    Debug.Log(a + c);
    const empty: string = "";
    const result: string = empty + a;
    Debug.Log(result);
  }
}
