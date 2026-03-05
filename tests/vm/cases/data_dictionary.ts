import {
  DataDictionary,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class DataDictionaryTest extends UdonSharpBehaviour {
  Start(): void {
    const dict: DataDictionary = new DataDictionary();
    dict.SetValue(new DataToken("name"), new DataToken("Alice"));
    dict.SetValue(new DataToken("age"), new DataToken(30));
    Debug.Log("set 2 values");
    Debug.Log(dict.ContainsKey(new DataToken("name")));
    Debug.Log(dict.ContainsKey(new DataToken("missing")));
  }
}
