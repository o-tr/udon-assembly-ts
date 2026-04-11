import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class StringConcatTest extends UdonSharpBehaviour {
  Start(): void {
    const name: string = "World";
    const greeting: string = "Hello, " + name + "! " + "Welcome.";
    Debug.Log(greeting);
  }
}
