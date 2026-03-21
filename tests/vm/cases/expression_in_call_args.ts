import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ExpressionInCallArgs extends UdonSharpBehaviour {
  add(a: number, b: number): number {
    return a + b;
  }

  abs(x: number): number {
    return x > 0 ? x : -x;
  }

  Start(): void {
    const a: number = 3;
    const b: number = 4;
    const c: number = 5;

    // Complex expressions as arguments
    const r1: number = this.add(a * 2, b + c);
    Debug.Log(r1); // 6 + 9 = 15

    // Nested method call in argument
    const r2: number = this.add(this.abs(-7), this.abs(3));
    Debug.Log(r2); // 7 + 3 = 10

    // Ternary in argument
    const flag: boolean = true;
    const r3: number = this.add(flag ? 10 : 0, 5);
    Debug.Log(r3); // 10 + 5 = 15
  }
}
