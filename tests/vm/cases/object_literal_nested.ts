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
    const obj: DataDictionary = { data: { msg: "hello" } };
    Debug.Log(obj.ContainsKey(new DataToken("data")));
    const innerToken: DataToken = obj.GetValue(new DataToken("data"));
    const inner: DataDictionary = innerToken.DataDictionary;
    const msgToken: DataToken = inner.GetValue(new DataToken("msg"));
    Debug.Log(msgToken.String);
  }
}
