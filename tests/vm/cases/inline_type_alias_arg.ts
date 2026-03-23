import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

type Config = { value: number; label: string };

class Processor {
  run(cfg: Config): number {
    return cfg.value;
  }

  describe(cfg: Config): string {
    return cfg.label;
  }
}

@UdonBehaviour()
export class InlineTypeAliasArg extends UdonSharpBehaviour {
  private proc: Processor = new Processor();

  Start(): void {
    const result = this.proc.run({ value: 99, label: "hello" });
    Debug.Log(result);
    const desc = this.proc.describe({ value: 0, label: "world" });
    Debug.Log(desc);
  }
}
