import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class NestedTernary extends UdonSharpBehaviour {
  classify(x: number): string {
    return x > 10 ? "big" : x > 5 ? "medium" : "small";
  }

  Start(): void {
    Debug.Log(this.classify(15)); // big
    Debug.Log(this.classify(7)); // medium
    Debug.Log(this.classify(2)); // small
  }
}
