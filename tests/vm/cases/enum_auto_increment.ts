import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

enum Priority {
  Low,
  Medium,
  High = 10,
  Critical,
}

@UdonBehaviour()
export class EnumAutoIncrement extends UdonSharpBehaviour {
  Start(): void {
    // Auto-increment from 0
    Debug.Log(Priority.Low); // "0"
    Debug.Log(Priority.Medium); // "1"
    // Explicit value with gap
    Debug.Log(Priority.High); // "10"
    // Auto-increment from explicit value
    Debug.Log(Priority.Critical); // "11"

    // Enum in comparison
    const p: number = Priority.High;
    if (p > Priority.Medium) {
      Debug.Log("above medium");
    }
  }
}
