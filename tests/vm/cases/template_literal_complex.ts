import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class TemplateLiteralComplex extends UdonSharpBehaviour {
  Start(): void {
    // Arithmetic expression in template literal
    const a: number = 10;
    const b: number = 20;
    Debug.Log(`result: ${a + b}`); // result: 30

    // Boolean expression in template literal
    const name: string = "Alice";
    const age: number = 25;
    Debug.Log(`${name} is ${age > 18}`); // Alice is True

    // Multiple variables in template literal
    const x: number = 1;
    const y: number = 2;
    const z: number = 3;
    Debug.Log(`${x}-${y}-${z}`); // 1-2-3
  }
}
