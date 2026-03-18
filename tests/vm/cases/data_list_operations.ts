import {
  DataList,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class DataListOperations extends UdonSharpBehaviour {
  Start(): void {
    const list: DataList = new DataList();
    list.Add(new DataToken(10));
    list.Add(new DataToken(20));
    list.Add(new DataToken(30));
    Debug.Log(list.Count);
    const second: DataToken = list.get_Item(1);
    Debug.Log(second.Float);
    const removed: boolean = list.Remove(new DataToken(20));
    Debug.Log(removed);
    Debug.Log(list.Count);
    const first: DataToken = list.get_Item(0);
    Debug.Log(first.Float);
  }
}
