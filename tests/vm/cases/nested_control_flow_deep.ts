import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class NestedControlFlowDeep extends UdonSharpBehaviour {
  Start(): void {
    // While → for → if/else: 3-level nesting
    // Outer: while i < 3
    // Inner: for j = 0..4, break at j == 3
    // Count iterations where j is even
    let count: number = 0;
    let i: number = 0;
    while (i < 3) {
      for (let j: number = 0; j < 5; j = j + 1) {
        if (j === 3) {
          break;
        }
        if (j % 2 === 0) {
          count = count + 1;
        }
      }
      i = i + 1;
    }
    // Each outer iteration: j=0(even,count++), j=1(odd), j=2(even,count++), j=3(break)
    // 3 outer iterations * 2 even per inner = 6
    Debug.Log(count); // 6

    // Verify outer loop ran to completion
    Debug.Log(i); // 3

    // Nested do-while inside for
    let total: number = 0;
    for (let k: number = 1; k <= 3; k = k + 1) {
      let n: number = 0;
      do {
        total = total + k;
        n = n + 1;
      } while (n < 2);
    }
    // k=1: total += 1 twice = 2, k=2: total += 2 twice = 6, k=3: total += 3 twice = 12
    Debug.Log(total); // 12
  }
}
