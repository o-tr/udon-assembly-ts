import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class StringConcatBinaryFallback extends UdonSharpBehaviour {
  Start(): void {
    const a: UdonInt = 5 as UdonInt;
    const b: UdonInt = 3 as UdonInt;

    // Left operand is non-string (int + int result), right is string literal.
    // The chain flattener cannot detect this as a string chain because the
    // left sub-expression (a + b) is not string-typed.
    // This exercises the ToString fallback at expression.ts:441-473.
    const s1: string = `${a + b} items`;
    Debug.Log(s1); // 8 items

    // Mirror case: string on the left, non-string on the right
    const s2: string = `total: ${a + b}`;
    Debug.Log(s2); // total: 8
  }
}
