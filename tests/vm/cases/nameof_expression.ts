import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

declare function nameof(value: unknown): string;

@UdonBehaviour()
export class NameofExpression extends UdonSharpBehaviour {
  Start(): void {
    // nameof should resolve to the identifier name as a string literal
    const myValue: number = 10;
    const name1: string = nameof(myValue);
    Debug.Log(name1); // "myValue"

    const anotherVar: string = "hello";
    const name2: string = nameof(anotherVar);
    Debug.Log(name2); // "anotherVar"
  }
}
