import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class BlockScoping extends UdonSharpBehaviour {
  Start(): void {
    const a: number = 10;
    const b: number = 20;
    const c: number = 30;
    Debug.Log(a + b + c);

    let sum: number = 0;
    for (let i: number = 0; i < 5; i = i + 1) {
      sum = sum + i;
    }
    Debug.Log(sum);

    const greeting: string = "Hello";
    const target: string = "World";
    const sep: string = " ";
    Debug.Log(greeting + sep + target);

    let x: number = 1;
    let y: number = 2;
    const temp: number = x;
    x = y;
    y = temp;
    Debug.Log(x);
    Debug.Log(y);
  }
}
