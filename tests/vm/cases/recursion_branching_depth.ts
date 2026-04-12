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
export class RecursionBranchingDepth extends UdonSharpBehaviour {
  @RecursiveMethod
  private branch(n: number): number {
    if (n <= 1) {
      return 1;
    }
    return this.branch(n - 1) + this.branch(n - 2);
  }

  Start(): void {
    Debug.Log(this.branch(4));
    Debug.Log(this.branch(5));
  }
}
