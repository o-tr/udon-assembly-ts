import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class MethodChainNumericTest extends UdonSharpBehaviour {
  private addOne(value: number): number {
    return value + 1;
  }

  private multiplyByTwo(value: number): number {
    return value * 2;
  }

  private clamp(value: number, min: number, max: number): number {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  Start(): void {
    const result = this.clamp(this.multiplyByTwo(this.addOne(5)), 0, 20);
    Debug.Log(result);
  }
}
