import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class StringOps extends UdonSharpBehaviour {
  Start(): void {
    const greeting: string = "Hello";
    const name: string = "World";
    Debug.Log(greeting + " " + name);
  }
}
