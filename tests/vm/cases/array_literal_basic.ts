import {
  DataList,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ArrayLiteralBasic extends UdonSharpBehaviour {
  Start(): void {
    const arr: DataList = [10, 20, 30];
    Debug.Log(arr.Count);
    const first: DataToken = arr.get_Item(0);
    Debug.Log(first.Float);
    const last: DataToken = arr.get_Item(2);
    Debug.Log(last.Float);
  }
}
