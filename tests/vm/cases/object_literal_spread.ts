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
    // Test ShallowClone + additional SetValue (spread pattern equivalent)
    const base: DataDictionary = new DataDictionary();
    base.SetValue(new DataToken("name"), new DataToken("Alice"));
    base.SetValue(new DataToken("age"), new DataToken(30.0));
    const extended: DataDictionary = base.ShallowClone();
    extended.SetValue(new DataToken("city"), new DataToken("NYC"));
    const nameVal: DataToken = extended.GetValue(new DataToken("name"));
    Debug.Log(nameVal.String);
    const ageVal: DataToken = extended.GetValue(new DataToken("age"));
    Debug.Log(ageVal.Float);
    const cityVal: DataToken = extended.GetValue(new DataToken("city"));
    Debug.Log(cityVal.String);
    Debug.Log(extended.Count);
  }
}
