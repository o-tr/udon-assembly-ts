import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

// Faithful reproducer for mahjong-t2 PC 0x0001C414.
// Matches YakuRegistry + YakuEvaluator pattern:
//   - IYaku is a TYPE ALIAS (matches mahjong; interface variant already passes).
//   - Registry populates Map<string, IYaku> in its constructor via registerAllYaku.
//   - Consumer receives registry as ctor param and iterates names calling
//     registry.get(name) for each.
// SoA tracking of Registry is forced by a preamble loop.

type IYaku = {
  readonly name: string;
};

class TanyaoYaku implements IYaku {
  readonly name: string = "Tanyao";
}

class PinfuYaku implements IYaku {
  readonly name: string = "Pinfu";
}

class Registry {
  private yaku: Map<string, IYaku> = new Map();

  constructor() {
    this.registerAllYaku();
  }

  private registerAllYaku(): void {
    this.register(new TanyaoYaku());
    this.register(new PinfuYaku());
  }

  private register(y: IYaku): void {
    this.yaku.set(y.name, y);
  }

  get(name: string): IYaku | null {
    return this.yaku.get(name) ?? null;
  }
}

class Consumer {
  private registry!: Registry;
  private found: IYaku[] = [];

  constructor(registry: Registry) {
    this.registry = registry;
    this.build();
  }

  private build(): void {
    const names = ["Tanyao", "Pinfu"];
    for (const n of names) {
      const y = this.registry.get(n);
      if (y !== null) this.found.push(y);
    }
  }

  getFoundCount(): number {
    return this.found.length;
  }
}

@UdonBehaviour()
export class MapSoaInstSplitReproducer extends UdonSharpBehaviour {
  Start(): void {
    for (let i = 0; i < 1; i++) {
      const _warm = new Registry();
      Debug.Log(_warm.get("Tanyao") !== null ? "WARM:OK" : "WARM:NULL");
    }

    const registry = new Registry();
    Debug.Log(registry.get("Tanyao") !== null ? "DIRECT:OK" : "DIRECT:NULL");

    const consumer = new Consumer(registry);
    Debug.Log(consumer.getFoundCount());
  }
}
