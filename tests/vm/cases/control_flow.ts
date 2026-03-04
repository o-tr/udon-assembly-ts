import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ControlFlow extends UdonSharpBehaviour {
  Start(): void {
    const x: number = 10;
    if (x > 5) {
      Debug.Log("greater");
    } else {
      Debug.Log("not greater");
    }

    let i: number = 0;
    while (i < 3) {
      Debug.Log(i);
      i = i + 1;
    }

    for (let j: number = 10; j < 13; j = j + 1) {
      Debug.Log(j);
    }
  }
}
