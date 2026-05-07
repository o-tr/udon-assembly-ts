import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class TemplateLiteralManyParts extends UdonSharpBehaviour {
  Start(): void {
    // Template literal with multiple interpolations (under StringBuilder threshold)
    const a: UdonInt = 1n as UdonInt;
    const b: UdonInt = 2n as UdonInt;
    const c: UdonInt = 3n as UdonInt;
    Debug.Log(`${a}-${b}-${c}`); // 1-2-3

    // Template with expressions
    const x: number = 10;
    const y: number = 20;
    Debug.Log(`sum=${x + y}`); // sum=30

    // Nested template via variable
    const name: string = "test";
    const val: UdonInt = 42n as UdonInt;
    Debug.Log(`${name}:${val}`); // test:42
  }
}
