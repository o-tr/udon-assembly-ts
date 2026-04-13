import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ArrayIndexMutationTest extends UdonSharpBehaviour {
  Start(): void {
    const values: number[] = [1, 2, 3, 4];
    values[1] = values[0] + values[2];
    values[3] = values[1] * 2;

    Debug.Log(values[1]);
    Debug.Log(values[3]);
  }
}
