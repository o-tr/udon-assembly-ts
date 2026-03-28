import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

// Verifies that interface dispatch correctly unifies return-type tracking when
// different concrete implementors return inline instances of a shared type alias.

type Result = { value: number; ok: boolean };

interface IProcessor {
  compute(x: number): Result;
}

class AddProcessor implements IProcessor {
  compute(x: number): Result {
    return { value: x + 10, ok: true };
  }
}

class MulProcessor implements IProcessor {
  compute(x: number): Result {
    return { value: x * 3, ok: false };
  }
}

@UdonBehaviour()
export class InlineInterfaceReturnDispatch extends UdonSharpBehaviour {
  private p1: IProcessor = new AddProcessor();
  private p2: IProcessor = new MulProcessor();

  Start(): void {
    const r1 = this.p1.compute(5);
    Debug.Log(r1.value); // 15
    Debug.Log(r1.ok); // True

    const r2 = this.p2.compute(4);
    Debug.Log(r2.value); // 12
    Debug.Log(r2.ok); // False
  }
}
