import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class IncrementDecrement extends UdonSharpBehaviour {
  Start(): void {
    let x: number = 0;
    x = x + 1;
    Debug.Log(x);
    x = x + 1;
    Debug.Log(x);
    x = x - 1;
    Debug.Log(x);

    let sum: number = 0;
    let i: number = 1;
    while (i <= 10) {
      sum = sum + i;
      i = i + 1;
    }
    Debug.Log(sum);

    let product: number = 1;
    let j: number = 1;
    while (j <= 5) {
      product = product * j;
      j = j + 1;
    }
    Debug.Log(product);
  }
}
