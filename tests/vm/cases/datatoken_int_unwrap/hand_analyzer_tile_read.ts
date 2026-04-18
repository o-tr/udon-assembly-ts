import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import {
  type UdonInt,
  UdonTypeConverters,
} from "@ootr/udon-assembly-ts/stubs/UdonTypes";
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
      instances.push(
        new Tile(
          UdonTypeConverters.toUdonInt(i),
          UdonTypeConverters.toUdonInt(i),
        ),
      );
    }
    Tile._instances = instances;
    return instances;
  }

  static get(idx: UdonInt): Tile {
    return Tile._getInstances()[idx as number];
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
      sum += hand.tiles[i].kind as number;
    }
    return UdonTypeConverters.toUdonInt(sum);
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
      Tile.get(UdonTypeConverters.toUdonInt(2)),
      Tile.get(UdonTypeConverters.toUdonInt(3)),
      Tile.get(UdonTypeConverters.toUdonInt(5)),
    ]);
    Debug.Log(analyzer.sumKinds(hand) as number);
    Debug.Log(analyzer.firstKind(hand) as number);
  }
}
