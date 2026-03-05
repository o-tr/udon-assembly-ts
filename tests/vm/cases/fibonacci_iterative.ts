import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class FibonacciIterative extends UdonSharpBehaviour {
  fibonacci(n: number): number {
    if (n <= 1) {
      return n;
    }
    let a: number = 0;
    let b: number = 1;
    let i: number = 2;
    while (i <= n) {
      const temp: number = a + b;
      a = b;
      b = temp;
      i = i + 1;
    }
    return b;
  }

  Start(): void {
    Debug.Log(this.fibonacci(0));
    Debug.Log(this.fibonacci(1));
    Debug.Log(this.fibonacci(5));
    Debug.Log(this.fibonacci(10));
  }
}
