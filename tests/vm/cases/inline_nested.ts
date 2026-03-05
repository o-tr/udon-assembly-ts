import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Inner {
  val: number = 42;

  getVal(): number {
    return this.val;
  }
}

class Outer {
  inner: Inner = new Inner();

  getInnerVal(): number {
    return this.inner.getVal();
  }
}

@UdonBehaviour()
export class InlineNested extends UdonSharpBehaviour {
  private outer: Outer = new Outer();

  Start(): void {
    Debug.Log(this.outer.getInnerVal());
    const doubled: number = this.outer.getInnerVal() * 2;
    Debug.Log(doubled);
  }
}
