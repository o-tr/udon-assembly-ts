import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class DoWhile extends UdonSharpBehaviour {
  Start(): void {
    let i: number = 0;
    do {
      Debug.Log(i);
      i = i + 1;
    } while (i < 3);
  }
}
