import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class StringMethodsBasic extends UdonSharpBehaviour {
  Start(): void {
    const text: string = "Hello World";
    Debug.Log(text.Contains("World"));
    Debug.Log(text.Contains("xyz"));
    Debug.Log(text.StartsWith("Hello"));
    Debug.Log(text.EndsWith("World"));
    Debug.Log(text.IndexOf("World"));
  }
}
