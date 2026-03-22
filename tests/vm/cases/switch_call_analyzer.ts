import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Helper {
  getValue(n: number): number {
    return n * 10;
  }
}

@UdonBehaviour()
export class SwitchCallAnalyzer extends UdonSharpBehaviour {
  private helper: Helper = new Helper();

  Start(): void {
    const code: number = 2;
    switch (code) {
      case 1:
        Debug.Log(this.helper.getValue(1));
        break;
      case 2:
        Debug.Log(this.helper.getValue(2));
        break;
      default:
        Debug.Log(this.helper.getValue(0));
        break;
    }
  }
}
