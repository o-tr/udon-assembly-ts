import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class IncrementOperators extends UdonSharpBehaviour {
  Start(): void {
    // Postfix increment on number (Single)
    let x: number = 5;
    x++;
    Debug.Log(x); // 6

    // Postfix decrement
    x--;
    Debug.Log(x); // 5

    // Multiple increments
    x++;
    x++;
    x++;
    Debug.Log(x); // 8

    // Increment in while loop
    let count: number = 0;
    let i: number = 0;
    while (i < 5) {
      count++;
      i++;
    }
    Debug.Log(count); // 5
  }
}
