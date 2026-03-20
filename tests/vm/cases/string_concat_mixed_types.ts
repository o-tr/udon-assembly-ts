import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class StringConcatMixedTypes extends UdonSharpBehaviour {
  Start(): void {
    const intVal: UdonInt = 42 as UdonInt;
    const boolVal: boolean = true;
    const floatVal: number = 3.14;

    // String + int
    Debug.Log(`val=${intVal}`); // val=42

    // String + bool (C# format: True/False)
    Debug.Log(`flag=${boolVal}`); // flag=True

    // String + float
    Debug.Log(`f=${floatVal}`); // f=3.14

    // Mixed chain: string + int + string + bool
    const mixed: string = `n=${intVal} b=${boolVal}`;
    Debug.Log(mixed); // n=42 b=True
  }
}
