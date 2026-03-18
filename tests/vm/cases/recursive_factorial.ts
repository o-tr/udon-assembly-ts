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
export class RecursiveFactorial extends UdonSharpBehaviour {
  @RecursiveMethod
  factorial(n: number): number {
    if (n <= 1) {
      return 1;
    }
    return n * this.factorial(n - 1);
  }

  Start(): void {
    Debug.Log(this.factorial(0));
    Debug.Log(this.factorial(1));
    Debug.Log(this.factorial(3));
    Debug.Log(this.factorial(5));
  }
}
