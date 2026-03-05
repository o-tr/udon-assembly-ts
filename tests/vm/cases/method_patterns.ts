import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class MethodPatterns extends UdonSharpBehaviour {
  Max(a: number, b: number): number {
    if (a > b) {
      return a;
    }
    return b;
  }

  Clamp(value: number, lo: number, hi: number): number {
    if (value < lo) {
      return lo;
    }
    if (value > hi) {
      return hi;
    }
    return value;
  }

  Start(): void {
    Debug.Log(this.Max(10, 20));
    Debug.Log(this.Max(30, 20));
    Debug.Log(this.Clamp(5, 0, 10));
    Debug.Log(this.Clamp(0 - 5, 0, 10));
    Debug.Log(this.Clamp(15, 0, 10));
    let combined: number = this.Max(3, 7) + this.Max(1, 2);
    Debug.Log(combined);
  }
}
