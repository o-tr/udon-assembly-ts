import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class SwitchContinueInLoop extends UdonSharpBehaviour {
  Start(): void {
    for (let i: number = 0; i < 5; i++) {
      switch (i) {
        case 2:
          Debug.Log("skip");
          continue;
      }
      Debug.Log(i);
    }
  }
}
