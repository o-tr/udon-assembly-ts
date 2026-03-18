import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

function RecursiveMethod(
  _target: object,
  _key: string,
  desc: PropertyDescriptor,
): PropertyDescriptor {
  return desc;
}

@UdonBehaviour()
export class RecursiveWithLocals extends UdonSharpBehaviour {
  @RecursiveMethod
  sumToN(n: number): number {
    if (n <= 0) {
      return 0;
    }
    const result: number = this.sumToN(n - 1);
    return n + result;
  }

  Start(): void {
    Debug.Log(this.sumToN(10));
  }
}
