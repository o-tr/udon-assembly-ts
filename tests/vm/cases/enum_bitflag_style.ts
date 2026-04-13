import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

enum AccessFlag {
  None = 0,
  Read = 1,
  Write = 2,
  Execute = 4,
}

@UdonBehaviour()
export class EnumBitflagStyle extends UdonSharpBehaviour {
  Start(): void {
    const mask = AccessFlag.Read | AccessFlag.Write;
    const hasWrite = (mask & AccessFlag.Write) !== AccessFlag.None;
    const hasExecute = (mask & AccessFlag.Execute) !== AccessFlag.None;

    Debug.Log(mask);
    Debug.Log(hasWrite);
    Debug.Log(hasExecute);
  }
}
