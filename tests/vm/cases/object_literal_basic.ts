import {
  DataDictionary,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ObjectLiteralBasic extends UdonSharpBehaviour {
  Start(): void {
    const obj: DataDictionary = { name: "Alice", age: 30 };
    const nameVal: DataToken = obj.GetValue(new DataToken("name"));
    Debug.Log(nameVal.String);
    const ageVal: DataToken = obj.GetValue(new DataToken("age"));
    Debug.Log(ageVal.Float);
    Debug.Log(obj.ContainsKey(new DataToken("name")));
  }
}
