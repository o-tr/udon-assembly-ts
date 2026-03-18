import {
  DataDictionary,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ObjectLiteralSpread extends UdonSharpBehaviour {
  Start(): void {
    const base: DataDictionary = { name: "Alice", age: 30 };
    const extended: DataDictionary = { ...base, city: "NYC" };
    const nameVal: DataToken = extended.GetValue(new DataToken("name"));
    Debug.Log(nameVal.String);
    const ageVal: DataToken = extended.GetValue(new DataToken("age"));
    Debug.Log(ageVal.Float);
    const cityVal: DataToken = extended.GetValue(new DataToken("city"));
    Debug.Log(cityVal.String);
    Debug.Log(extended.Count);
  }
}
