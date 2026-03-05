import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class MathHelper {
  multiply(a: number, b: number): number {
    return a * b;
  }

  addThree(a: number, b: number, c: number): number {
    return a + b + c;
  }
}

@UdonBehaviour()
export class InlineWithParams extends UdonSharpBehaviour {
  private math: MathHelper = new MathHelper();

  Start(): void {
    Debug.Log(this.math.multiply(6, 7));
    Debug.Log(this.math.addThree(10, 20, 30));
  }
}
