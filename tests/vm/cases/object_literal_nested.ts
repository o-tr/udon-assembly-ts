import {
  DataDictionary,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ObjectLiteralNested extends UdonSharpBehaviour {
  Start(): void {
    // Build nested DataDictionary manually to test multi-level access
    const inner: DataDictionary = new DataDictionary();
    inner.SetValue(new DataToken("msg"), new DataToken("hello"));
    const outer: DataDictionary = new DataDictionary();
    outer.SetValue(new DataToken("data"), new DataToken(inner));
    Debug.Log(outer.ContainsKey(new DataToken("data")));
    const innerToken: DataToken = outer.GetValue(new DataToken("data"));
    const innerDict: DataDictionary = innerToken.DataDictionary;
    const msgToken: DataToken = innerDict.GetValue(new DataToken("msg"));
    Debug.Log(msgToken.String);
  }
}
