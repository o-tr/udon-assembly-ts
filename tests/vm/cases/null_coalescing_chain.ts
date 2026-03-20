import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class NullCoalescingChain extends UdonSharpBehaviour {
  getNonNull(): string | null {
    return "first";
  }

  getNull(): string | null {
    return null;
  }

  Start(): void {
    // First non-null: takes "first"
    const a: string = this.getNonNull() ?? "second" ?? "third";
    Debug.Log(a); // first

    // First is null, second non-null: takes "second"
    const b: string = this.getNull() ?? "second" ?? "third";
    Debug.Log(b); // second

    // Nested with all null except last
    const c: string = this.getNull() ?? this.getNull() ?? "fallback";
    Debug.Log(c); // fallback
  }
}
