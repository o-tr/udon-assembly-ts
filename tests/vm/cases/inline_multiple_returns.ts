import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Classifier {
  classify(n: number): string {
    if (n < 0) {
      return "negative";
    }
    if (n === 0) {
      return "zero";
    }
    return "positive";
  }
}

@UdonBehaviour()
export class InlineMultipleReturns extends UdonSharpBehaviour {
  private cls: Classifier = new Classifier();

  Start(): void {
    Debug.Log(this.cls.classify(-5));
    Debug.Log(this.cls.classify(0));
    Debug.Log(this.cls.classify(10));
  }
}
