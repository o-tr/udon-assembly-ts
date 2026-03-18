import {
  DataDictionary,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class DataDictionaryShallowClone extends UdonSharpBehaviour {
  Start(): void {
    const original: DataDictionary = new DataDictionary();
    original.SetValue(new DataToken("name"), new DataToken("Alice"));
    const clone: DataDictionary = original.ShallowClone();
    const origName: DataToken = original.GetValue(new DataToken("name"));
    Debug.Log(origName.String);
    const cloneName: DataToken = clone.GetValue(new DataToken("name"));
    Debug.Log(cloneName.String);
    clone.SetValue(new DataToken("name"), new DataToken("Bob"));
    const cloneNameAfter: DataToken = clone.GetValue(new DataToken("name"));
    Debug.Log(cloneNameAfter.String);
    const origNameAfter: DataToken = original.GetValue(new DataToken("name"));
    Debug.Log(origNameAfter.String);
  }
}
