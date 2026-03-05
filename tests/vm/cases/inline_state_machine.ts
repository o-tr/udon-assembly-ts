import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class StateMachine {
  state: number = 0;

  next(): void {
    if (this.state < 2) {
      this.state = this.state + 1;
    }
  }

  reset(): void {
    this.state = 0;
  }

  getStateName(): string {
    if (this.state === 0) {
      return "idle";
    }
    if (this.state === 1) {
      return "running";
    }
    return "done";
  }
}

@UdonBehaviour()
export class InlineStateMachine extends UdonSharpBehaviour {
  private sm: StateMachine = new StateMachine();

  Start(): void {
    Debug.Log(this.sm.getStateName());
    this.sm.next();
    Debug.Log(this.sm.getStateName());
    this.sm.next();
    Debug.Log(this.sm.getStateName());
    this.sm.reset();
    Debug.Log(this.sm.getStateName());
  }
}
