import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class StringMethodsTransform extends UdonSharpBehaviour {
  Start(): void {
    const text: string = "  Hello World  ";
    Debug.Log(text.Trim());
    Debug.Log(text.ToLower());
    Debug.Log(text.ToUpper());
  }
}
