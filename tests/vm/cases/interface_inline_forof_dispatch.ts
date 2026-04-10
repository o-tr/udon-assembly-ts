import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

// Verifies that for-of loop dispatch correctly calls each inline class's method
// through a common interface, and that state mutations are preserved via write-back.
// Three implementing classes exercise the 3-branch classId dispatch.

interface IScorer {
  getLabel(): string;
  addPoints(n: number): void;
  getPoints(): number;
}

class FixedScorer implements IScorer {
  private points: number = 0;
  private label: string = "fixed";

  getLabel(): string {
    return this.label;
  }

  addPoints(n: number): void {
    this.points += n;
  }

  getPoints(): number {
    return this.points;
  }
}

class DoubleScorer implements IScorer {
  private points: number = 0;
  private label: string = "double";

  getLabel(): string {
    return this.label;
  }

  addPoints(n: number): void {
    this.points += n * 2;
  }

  getPoints(): number {
    return this.points;
  }
}

class BonusScorer implements IScorer {
  private points: number = 0;
  private label: string = "bonus";

  getLabel(): string {
    return this.label;
  }

  addPoints(n: number): void {
    this.points += n + 10;
  }

  getPoints(): number {
    return this.points;
  }
}

@UdonBehaviour()
export class InterfaceInlineForofDispatch extends UdonSharpBehaviour {
  private scorers: IScorer[] = [
    new FixedScorer(),
    new DoubleScorer(),
    new BonusScorer(),
  ];

  Start(): void {
    // 1. Call getLabel() on each class via for-of
    for (const s of this.scorers) {
      Debug.Log(s.getLabel());
    }
    // Expected: "fixed", "double", "bonus"

    // 2. Mutate state via parameterized method
    for (const s of this.scorers) {
      s.addPoints(5);
    }

    // 3. Read back mutated state — verifies write-back persisted
    for (const s of this.scorers) {
      Debug.Log(s.getPoints());
    }
    // Expected: 5 (0+5), 10 (0+5*2), 15 (0+5+10)

    // 4. Second mutation round — verifies state accumulates correctly
    for (const s of this.scorers) {
      s.addPoints(3);
    }

    for (const s of this.scorers) {
      Debug.Log(s.getPoints());
    }
    // Expected: 8 (5+3), 16 (10+3*2), 28 (15+3+10)

    // 5. Accumulate total — verifies return value plumbing through iface_ret
    let total: number = 0;
    for (const s of this.scorers) {
      total += s.getPoints();
    }
    Debug.Log(total);
    // Expected: 52 (8+16+28)
  }
}
