import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class StringConcatMulti extends UdonSharpBehaviour {
  Start(): void {
    const name: string = "Player";
    const score: number = 42;
    const msg: string = `Name: ${name}, Score: ${score}`;
    Debug.Log(msg);
    const a: string = "Hello";
    const b: string = " ";
    const c: string = "World";
    Debug.Log(a + b + c);
  }
}
