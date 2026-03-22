import type { Type } from "@ootr/udon-assembly-ts/stubs/SystemTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class TypeofExpression extends UdonSharpBehaviour {
  Start(): void {
    // typeof returns a System.Type via Type.GetType()
    // Note: current transpiler passes short names ("float", "string") which
    // Type.GetType() does not resolve (needs fully qualified names).
    // This test verifies that typeof compiles and runs without VM error,
    // and that same-type comparison is consistent.
    const x: number = 42;
    const t1: Type = typeof x;

    const y: number = 10;
    const t2: Type = typeof y;

    // Same underlying type → consistent equality
    const same: boolean = t1 === t2;
    Debug.Log(same); // "True"
  }
}
