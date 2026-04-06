import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Box {
  constructor(public v: number) {}
}

@UdonBehaviour()
export class SystemObjectArrayExternCore extends UdonSharpBehaviour {
  Start(): void {
    const left: Box[] = [new Box(10), new Box(20)];
    const right: Box[] = [new Box(30)];
    left.concat(right);
    left.concat(new Box(40));
    Debug.Log("concat_ok");
    Debug.Log("scalar_ok");
  }
}
