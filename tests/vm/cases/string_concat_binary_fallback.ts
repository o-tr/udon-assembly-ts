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
    // flattenStringConcatChain returns null here because recursion into (a + b)
    // finds neither operand is string-typed, so the chain builder aborts.
    // This exercises the pairwise ToString + String.Concat fallback in
    // visitBinaryExpression (the mixed-type string concat guard).
    // biome-ignore lint/style/useTemplate: intentionally testing binary + fallback path, not template literals
    const s1: string = a + b + " items";
    Debug.Log(s1); // 8 items

    // Mirror case: string on the left, non-string on the right
    // biome-ignore lint/style/useTemplate: intentionally testing binary + fallback path, not template literals
    const s2: string = "total: " + (a + b);
    Debug.Log(s2); // total: 8
  }
}
