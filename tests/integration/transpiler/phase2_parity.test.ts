/**
 * Phase 2 parity integration test
 */

import { describe, expect, it } from "vitest";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler";

describe("Phase 2 parity", () => {
  it("should transpile enum, for-of, cast, and switch", () => {
    const source = `
      enum TileType { Man, Pin, Sou, Wind, Dragon }

      @UdonBehaviour({ syncMode: 'Manual' })
      class MahjongDemo extends UdonSharpBehaviour {
        @UdonSynced() tiles: number[] = new Array<number>(136);

        Start(): void {
          for (const tile of this.tiles) {
            const type = tile as TileType;
            switch (type) {
              case TileType.Man:
                Debug.Log("Man");
                break;
              default:
                Debug.Log("Other");
                break;
            }
          }
        }
      }
    `;

    const transpiler = new TypeScriptToUdonTranspiler();
    const result = transpiler.transpile(source, { optimize: false });

    expect(result.uasm).toContain(".code_start");
    expect(result.uasm).toContain(".data_start");
  });
});
