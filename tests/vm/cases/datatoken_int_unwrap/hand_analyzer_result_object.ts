import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Tile {
  readonly kind: UdonInt;

  private constructor(kind: UdonInt) {
    this.kind = kind;
  }

  private static _instances: Tile[] | null = null;

  private static _getInstances(): Tile[] {
    if (Tile._instances !== null) return Tile._instances;
    const instances: Tile[] = [];
    for (let i = 0; i < 10; i += 1) {
      instances.push(new Tile(BigInt(i) as UdonInt));
    }
    Tile._instances = instances;
    return instances;
  }

  static get(idx: UdonInt): Tile {
    return Tile._getInstances()[Number(idx)];
  }
}

class Hand {
  readonly tiles: Tile[];
  constructor(tiles: Tile[]) {
    this.tiles = tiles;
  }
}

class AnalysisResult {
  readonly total: UdonInt;
  readonly firstKind: UdonInt;
  readonly isValid: boolean;
  constructor(total: UdonInt, firstKind: UdonInt, isValid: boolean) {
    this.total = total;
    this.firstKind = firstKind;
    this.isValid = isValid;
  }
}

class HandAnalyzer {
  analyze(hand: Hand): AnalysisResult {
    let total = 0;
    for (let i = 0; i < hand.tiles.length; i += 1) {
      total += Number(hand.tiles[i].kind);
    }
    return new AnalysisResult(
      BigInt(total) as UdonInt,
      hand.tiles[0].kind,
      hand.tiles.length > 0,
    );
  }
}

@UdonBehaviour()
export class HandAnalyzerResultObject extends UdonSharpBehaviour {
  Start(): void {
    const analyzer = new HandAnalyzer();
    const hand = new Hand([
      Tile.get(1n as UdonInt),
      Tile.get(4n as UdonInt),
      Tile.get(6n as UdonInt),
    ]);
    const result = analyzer.analyze(hand);
    Debug.Log(Number(result.total));
    Debug.Log(Number(result.firstKind));
    Debug.Log(result.isValid ? "True" : "False");
  }
}
