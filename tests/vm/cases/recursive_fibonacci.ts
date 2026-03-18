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
export class RecursiveFibonacci extends UdonSharpBehaviour {
  @RecursiveMethod
  fib(n: number): number {
    if (n <= 1) {
      return n;
    }
    return this.fib(n - 1) + this.fib(n - 2);
  }

  Start(): void {
    Debug.Log(this.fib(0));
    Debug.Log(this.fib(1));
    Debug.Log(this.fib(6));
    Debug.Log(this.fib(10));
  }
}
