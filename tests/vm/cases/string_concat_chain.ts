import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class StringConcatChain extends UdonSharpBehaviour {
  Start(): void {
    const a: string = "abc";
    const b: string = "def";
    Debug.Log(a + b);
    const x: number = 10;
    const y: number = 20;
    Debug.Log(`x=${x}, y=${y}`);
    Debug.Log(`sum=${x + y}`);
  }
}
