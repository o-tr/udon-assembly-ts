import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class StringTsCompatMethods extends UdonSharpBehaviour {
  Start(): void {
    const str: string = "Hello World";

    // indexOf
    Debug.Log(str.indexOf("World")); // 6
    Debug.Log(str.indexOf("xyz")); // -1

    // includes
    Debug.Log(str.includes("Hello")); // True
    Debug.Log(str.includes("xyz")); // False

    // startsWith
    Debug.Log(str.startsWith("Hello")); // True
    Debug.Log(str.startsWith("World")); // False

    // endsWith
    Debug.Log(str.endsWith("World")); // True
    Debug.Log(str.endsWith("Hello")); // False

    // toLowerCase / toUpperCase
    Debug.Log(str.toLowerCase()); // hello world
    Debug.Log(str.toUpperCase()); // HELLO WORLD

    // trim
    const padded: string = "  hi  ";
    Debug.Log(padded.trim()); // hi

    // slice (positive indices)
    Debug.Log(str.slice(6)); // World
    Debug.Log(str.slice(0, 5)); // Hello
  }
}
