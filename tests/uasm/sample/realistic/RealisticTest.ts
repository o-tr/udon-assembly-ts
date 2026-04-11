import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class RealisticTest extends UdonSharpBehaviour {
  private score: UdonInt = 0 as UdonInt;
  private highScore: UdonInt = 0 as UdonInt;
  private isPlaying: boolean = false;

  Start(): void {
    this.score = 0 as UdonInt;
    this.highScore = 100 as UdonInt;
    this.isPlaying = true;
  }

  AddScore(points: UdonInt): void {
    if (!this.isPlaying) return;

    this.score = (this.score + points) as UdonInt;
    if (this.score > this.highScore) {
      this.highScore = this.score;
      Debug.Log("New high score!");
    }

    const msg: string = `Score: ${this.score.toString()}`;
    Debug.Log(msg);
  }

  ResetGame(): void {
    this.score = 0 as UdonInt;
    this.isPlaying = true;
    Debug.Log("Game reset");
  }

  GetScore(): UdonInt {
    return this.score;
  }

  GetHighScore(): UdonInt {
    return this.highScore;
  }
}
