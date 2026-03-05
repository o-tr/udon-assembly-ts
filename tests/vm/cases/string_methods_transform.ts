import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class StringMethodsTransform extends UdonSharpBehaviour {
  Start(): void {
    const greeting: string = "Hello";
    const name: string = "World";
    const msg: string = `${greeting} ${name}`;
    Debug.Log(msg);
    const a: number = 10;
    const b: number = 5;
    const sum: number = a + b;
    Debug.Log(sum);
    Debug.Log(a - b);
  }
}
