import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Tile {
  readonly kind: UdonInt;
  readonly code: UdonInt;

  private constructor(kind: UdonInt, code: UdonInt) {
    this.kind = kind;
    this.code = code;
  }

  private static _instances: Tile[] | null = null;

  private static _getInstances(): Tile[] {
    if (Tile._instances !== null) return Tile._instances;
    const instances: Tile[] = [];
    for (let i = 0; i < 10; i += 1) {
      instances.push(new Tile(BigInt(i) as UdonInt, BigInt(i) as UdonInt));
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

class HandAnalyzer {
  sumKinds(hand: Hand): UdonInt {
    let sum = 0;
    for (let i = 0; i < hand.tiles.length; i += 1) {
      sum += Number(hand.tiles[i].kind);
    }
    return BigInt(sum) as UdonInt;
  }

  firstKind(hand: Hand): UdonInt {
    return hand.tiles[0].kind;
  }
}

@UdonBehaviour()
export class HandAnalyzerTileRead extends UdonSharpBehaviour {
  Start(): void {
    const analyzer = new HandAnalyzer();
    const hand = new Hand([
      Tile.get(2n as UdonInt),
      Tile.get(3n as UdonInt),
      Tile.get(5n as UdonInt),
    ]);
    Debug.Log(Number(analyzer.sumKinds(hand)));
    Debug.Log(Number(analyzer.firstKind(hand)));
  }
}
