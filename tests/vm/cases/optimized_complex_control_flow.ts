import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class OptimizedComplexControlFlow extends UdonSharpBehaviour {
  Start(): void {
    // 1) If/else chain exercising multi-branch CFG edges
    let sum: number = 0;
    for (let i: number = 1; i <= 10; i = i + 1) {
      if (i <= 3) {
        sum = sum + 1;
      } else if (i <= 7) {
        sum = sum + 10;
      } else {
        sum = sum + 100;
      }
    }
    // i=1..3: +3, i=4..7: +40, i=8..10: +300 -> sum=343
    Debug.Log(sum);

    // 2) While loop with break and continue
    let product: number = 1;
    let k: number = 1;
    while (k <= 10) {
      if (k % 3 === 0) {
        k = k + 1;
        continue;
      }
      if (k > 7) {
        break;
      }
      product = product * k;
      k = k + 1;
    }
    // k=1:1, k=2:2, k=3:skip, k=4:8, k=5:40, k=6:skip, k=7:280, k=8:break
    Debug.Log(product);

    // 3) Nested loops with inner break
    let total: number = 0;
    for (let a: number = 1; a <= 4; a = a + 1) {
      let b: number = 0;
      while (b < 10) {
        if (b >= a) {
          break;
        }
        total = total + a;
        b = b + 1;
      }
    }
    // a=1: +1, a=2: +4, a=3: +9, a=4: +16 -> total=30
    Debug.Log(total);
  }
}
