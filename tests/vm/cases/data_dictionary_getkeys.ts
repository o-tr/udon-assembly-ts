import {
  DataDictionary,
  DataList,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class DataDictionaryGetkeys extends UdonSharpBehaviour {
  Start(): void {
    const dict: DataDictionary = new DataDictionary();
    dict.SetValue(new DataToken("name"), new DataToken("Alice"));
    dict.SetValue(new DataToken("age"), new DataToken(30));
    const keys: DataList = dict.GetKeys();
    Debug.Log(keys.Count);
    const values: DataList = dict.GetValues();
    Debug.Log(values.Count);
  }
}
