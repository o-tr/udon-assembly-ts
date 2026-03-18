import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class CastAsExpression extends UdonSharpBehaviour {
  Start(): void {
    const a: number = 42 as number;
    Debug.Log(a);
    const b: string = "hello" as string;
    Debug.Log(b);
  }
}
