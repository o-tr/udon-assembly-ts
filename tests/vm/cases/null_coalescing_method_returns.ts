import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class NullCoalescingMethodReturns extends UdonSharpBehaviour {
  getNonNull(): string | null {
    return "hello";
  }

  getNull(): string | null {
    return null;
  }

  Start(): void {
    // Null coalescing with non-null method return
    const a: string = this.getNonNull() ?? "was-null";
    Debug.Log(a); // hello

    // Null coalescing with null method return
    const b: string = this.getNull() ?? "was-null";
    Debug.Log(b); // was-null

    // Chained null coalescing: null ?? null ?? value
    const c: string = this.getNull() ?? this.getNull() ?? "deep";
    Debug.Log(c); // deep

    // Chained null coalescing: null ?? non-null
    const d: string = this.getNull() ?? this.getNonNull() ?? "never";
    Debug.Log(d); // hello
  }
}
