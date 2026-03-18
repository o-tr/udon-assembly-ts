import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ForOfArray extends UdonSharpBehaviour {
  Start(): void {
    const nums: number[] = new Array<number>(3);
    nums[0] = 1;
    nums[1] = 2;
    nums[2] = 3;
    let sum: number = 0;
    for (const n of nums) {
      Debug.Log(n);
      sum = sum + n;
    }
    Debug.Log(sum);
  }
}
