import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

enum Color {
  Red = 1,
  Green = 5,
  Blue = 10,
}

@UdonBehaviour()
export class SwitchEnumAdvanced extends UdonSharpBehaviour {
  Start(): void {
    const c1: number = Color.Green;
    switch (c1) {
      case Color.Red:
        Debug.Log("red");
        break;
      case Color.Green:
        Debug.Log("green");
        break;
      case Color.Blue:
        Debug.Log("blue");
        break;
      default:
        Debug.Log("unknown");
        break;
    }

    // Test with value not matching Red
    const c2: number = Color.Blue;
    if (c2 !== Color.Red) {
      Debug.Log("not red");
    }
  }
}
