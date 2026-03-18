import {
  DataList,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ArrayLiteralIteration extends UdonSharpBehaviour {
  Start(): void {
    const arr: DataList = [10, 20, 30];
    let sum: number = 0;
    let i: number = 0;
    while (i < arr.Count) {
      const token: DataToken = arr.get_Item(i);
      const val: number = token.Float;
      Debug.Log(val);
      sum = sum + val;
      i = i + 1;
    }
    Debug.Log(sum);
  }
}
