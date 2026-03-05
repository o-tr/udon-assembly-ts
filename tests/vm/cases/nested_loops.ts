import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class NestedLoops extends UdonSharpBehaviour {
  Start(): void {
    let count: number = 0;
    for (let i: number = 0; i < 3; i = i + 1) {
      if (i == 2) {
        break;
      }
      for (let j: number = 0; j < 3; j = j + 1) {
        if (j == 1) {
          continue;
        }
        count = count + 1;
      }
    }
    Debug.Log(count);

    let sum: number = 0;
    let k: number = 0;
    while (k < 100) {
      if (k == 5) {
        break;
      }
      sum = sum + k;
      k = k + 1;
    }
    Debug.Log(sum);
  }
}
