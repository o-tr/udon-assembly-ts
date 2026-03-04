import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class MethodCalls extends UdonSharpBehaviour {
  Add(a: number, b: number): number {
    return a + b;
  }

  Start(): void {
    const result: number = this.Add(3, 4);
    Debug.Log(result);
  }
}
