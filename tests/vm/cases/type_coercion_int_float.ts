import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class TypeCoercionIntFloat extends UdonSharpBehaviour {
  Start(): void {
    const pi: number = 3.14;
    Debug.Log(pi);
    const doubled: number = pi * 2;
    Debug.Log(doubled);
    const intVal: number = 3;
    Debug.Log(intVal);
    const mixed: number = intVal + 4;
    Debug.Log(mixed);
  }
}
