import {
  DataList,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ForOfDataList extends UdonSharpBehaviour {
  Start(): void {
    const list: DataList = new DataList();
    list.Add(new DataToken(10));
    list.Add(new DataToken(20));
    list.Add(new DataToken(30));
    let sum: number = 0;
    for (const item of list) {
      const val: number = item.Float;
      Debug.Log(val);
      sum = sum + val;
    }
    Debug.Log(sum);
  }
}
