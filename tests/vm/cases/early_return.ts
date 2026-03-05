import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class EarlyReturn extends UdonSharpBehaviour {
  classify(n: number): string {
    if (n < 0) {
      return "negative";
    }
    if (n === 0) {
      return "zero";
    }
    if (n < 10) {
      return "small";
    }
    return "large";
  }

  Start(): void {
    Debug.Log(this.classify(0 - 5));
    Debug.Log(this.classify(0));
    Debug.Log(this.classify(3));
    Debug.Log(this.classify(100));
  }
}
