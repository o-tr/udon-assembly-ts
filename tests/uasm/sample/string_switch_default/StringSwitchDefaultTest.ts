import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class StringSwitchDefaultTest extends UdonSharpBehaviour {
  Start(): void {
    const command: string = "pause";
    let status = "";

    switch (command) {
      case "start":
        status = "started";
        break;
      case "stop":
        status = "stopped";
        break;
      default:
        status = "unknown";
        break;
    }

    Debug.Log(status);
  }
}
