/**
 * Tests for returnInstancePrefix type-metadata correctness.
 *
 * When a method returns an InterfaceTypeSymbol, the stable-prefix copy loop
 * must re-resolve each property's TypeSymbol through typeMapper.getAlias()
 * before stamping it on srcField/dstField.  Without this re-resolution,
 * a property whose type alias was registered *after* the interface (parse-order
 * issue) would carry a stale ClassTypeSymbol(udonType="Object"), causing the
 * Udon variable to be declared as %SystemObject instead of its correct type.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

describe("returnInstancePrefix field type re-resolution", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("re-resolves stale property type when type alias is declared after the interface", () => {
    // IResult references Score before Score is declared.
    // At parse time, IResult.score gets ClassTypeSymbol(name="Score",udonType="Object").
    // The fix ensures typeMapper.getAlias("Score") is called to get SystemSingle.
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

      interface IResult {
        score: Score;
        ok: boolean;
      }
      type Score = number;  // declared AFTER IResult -> stale at interface parse time

      interface IGame {
        compute(): IResult;
      }

      class GameImpl implements IGame {
        compute(): IResult {
          return { score: 7, ok: true };
        }
      }

      @UdonBehaviour()
      export class StaleAliasTest extends UdonSharpBehaviour {
        private g: IGame = new GameImpl();
        Start(): void {
          const r = this.g.compute();
          Debug.Log(r.score);
          Debug.Log(r.ok);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    // The stable-prefix variable for "score" must be %SystemSingle, not %SystemObject.
    // A stale alias would produce: __inline_ret_0_score: %SystemObject
    expect(result.uasm).toMatch(/__inline_ret_\d+_score:\s*%SystemSingle/);

    // No EXTERN call for IResult/Score property access
    expect(result.uasm).not.toMatch(/IResult\.__get_score/);
  });
});
