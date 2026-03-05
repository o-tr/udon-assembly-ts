import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class MethodChainCalls extends UdonSharpBehaviour {
  double(n: number): number {
    return n * 2;
  }

  add(a: number, b: number): number {
    return a + b;
  }

  negate(n: number): number {
    return 0 - n;
  }

  Start(): void {
    const a: number = this.double(this.add(3, 4));
    Debug.Log(a);
    const b: number = this.add(this.double(5), this.double(3));
    Debug.Log(b);
    const c: number = this.negate(this.double(this.add(1, 2)));
    Debug.Log(c);
  }
}
