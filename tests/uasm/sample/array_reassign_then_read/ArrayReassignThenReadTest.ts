import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ArrayReassignThenReadTest extends UdonSharpBehaviour {
  Start(): void {
    const values = [2, 4, 6];
    values[0] = values[1] + 1;
    values[2] = values[0] + values[1];

    Debug.Log(values[0]);
    Debug.Log(values[2]);
  }
}
