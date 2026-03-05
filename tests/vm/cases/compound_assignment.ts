import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class CompoundAssignment extends UdonSharpBehaviour {
  Start(): void {
    let x: number = 10;
    x = x + 5;
    Debug.Log(x);
    x = x - 3;
    Debug.Log(x);
    x = x * 2;
    Debug.Log(x);
    x = x / 4;
    Debug.Log(x);
    let y: number = 17;
    y = y % 5;
    Debug.Log(y);

    let acc: number = 0;
    let i: number = 1;
    while (i <= 5) {
      acc = acc + i;
      i = i + 1;
    }
    Debug.Log(acc);
  }
}
