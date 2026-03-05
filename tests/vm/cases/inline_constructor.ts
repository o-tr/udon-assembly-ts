import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Config {
  width: number = 10;
  height: number = 20;

  getArea(): number {
    return this.width * this.height;
  }
}

@UdonBehaviour()
export class InlineConstructor extends UdonSharpBehaviour {
  private config: Config = new Config();

  Start(): void {
    Debug.Log(this.config.getArea());
  }
}
