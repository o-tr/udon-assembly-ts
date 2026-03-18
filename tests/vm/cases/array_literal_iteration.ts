import {
  DataList,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ArrayLiteralIteration extends UdonSharpBehaviour {
  Start(): void {
    const arr: DataList = new DataList();
    arr.Add(new DataToken(10));
    arr.Add(new DataToken(20));
    arr.Add(new DataToken(30));
    let sum: number = 0;
    let i: number = 0;
    while (i < arr.Count) {
      const token: DataToken = arr.get_Item(i as UdonInt);
      const val: number = token.Float;
      Debug.Log(val);
      sum = sum + val;
      i = i + 1;
    }
    Debug.Log(sum);
  }
}
