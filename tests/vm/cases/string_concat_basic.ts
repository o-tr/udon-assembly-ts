import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class StringConcatBasic extends UdonSharpBehaviour {
  Start(): void {
    const a: string = "Hello";
    const b: string = "World";
    Debug.Log(`${a} ${b}`);
    const c: string = a + b;
    Debug.Log(c);
  }
}
