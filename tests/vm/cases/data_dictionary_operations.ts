import {
  DataDictionary,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class DataDictionaryOperations extends UdonSharpBehaviour {
  Start(): void {
    const dict: DataDictionary = new DataDictionary();
    dict.SetValue(new DataToken("name"), new DataToken("Alice"));
    dict.SetValue(new DataToken("age"), new DataToken(30));
    const nameVal: DataToken = dict.GetValue(new DataToken("name"));
    Debug.Log(nameVal.String);
    Debug.Log(dict.Count);
    const removed: boolean = dict.Remove(new DataToken("age"));
    Debug.Log(removed);
    Debug.Log(dict.Count);
    Debug.Log(dict.ContainsKey(new DataToken("age")));
  }
}
