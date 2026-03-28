/**
 * Tests for Fix D-1: 2-pass compilation.
 *
 * Also covers the vifaceCounter / instanceCounter separation fix:
 * when a for-of viface dispatch block fires in pass 2 (classIds pre-seeded)
 * but was a no-op in pass 1 (classIds null), the viface block must not
 * consume an instanceCounter slot — otherwise every subsequent `new Cls()`
 * in pass 2 would produce a shifted __inst_Cls_N+1 name that does not match
 * the __inst_Cls_N entries stored in allInlineInstances from pass 1.
 *
 * In single-pass compilation, allInlineInstances is populated incrementally as
 * constructor calls are encountered.  When a dispatch (viface or untracked) is
 * compiled before a concrete class's first `new` call, the dispatch has no
 * entries for that class → property access falls through to EXTERN.
 *
 * With 2-pass compilation, pass 1 fully populates allInlineInstances before
 * pass 2 generates dispatch code, so forward-referenced classes are included.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

describe("2-pass compilation: forward-referenced inline instances", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("includes forward-referenced concrete class in untracked dispatch", () => {
    // BoxB is assigned to a field (so it's in allInlineInstances after field init),
    // but in the Start() body a ternary produces an untracked IItem.
    // We verify both BoxA and BoxB appear in the dispatch (not just the first-seen one).
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

      interface IItem { value: number; }

      class BoxA implements IItem {
        value: number;
        constructor(v: number) { this.value = v; }
      }

      class BoxB implements IItem {
        value: number;
        constructor(v: number) { this.value = v; }
      }

      @UdonBehaviour()
      export class TwoPassTest extends UdonSharpBehaviour {
        private a: BoxA = new BoxA(10);
        private b: BoxB = new BoxB(20);
        private flag: boolean = true;

        Start(): void {
          // Ternary produces untracked IItem — dispatch must cover BoxA and BoxB.
          const item: IItem = this.flag ? this.a : this.b;
          Debug.Log(item.value);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    // Both BoxA and BoxB must appear in the untracked property dispatch.
    // The dispatch compares the handle against each known instance id.
    expect(result.tac).toMatch(/__inst_BoxA_0__handle/);
    expect(result.tac).toMatch(/__inst_BoxB_1__handle/);
    // Both branches of the dispatch must assign __uninst_prop_N
    const dispatchMatches = result.tac.match(
      /__uninst_prop_\d+ = __inst_Box[AB]_\d+_value/g,
    );
    expect(dispatchMatches).toHaveLength(2);
    // No EXTERN for IItem property getter
    expect(result.uasm).not.toMatch(/IItem\.__get_value/);
  });

  it("dispatch includes class whose constructor call appears later in Start()", () => {
    // LateBox is only instantiated after the conditional in Start().
    // With single-pass, the dispatch at the conditional site wouldn't include LateBox.
    // With 2-pass, pass 1 records the LateBox constructor call, and pass 2 includes it.
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

      interface IBox { val: number; }

      class EarlyBox implements IBox {
        val: number;
        constructor(v: number) { this.val = v; }
      }

      class LateBox implements IBox {
        val: number;
        constructor(v: number) { this.val = v; }
      }

      @UdonBehaviour()
      export class ForwardRefTest extends UdonSharpBehaviour {
        private early: EarlyBox = new EarlyBox(1);
        private flag: boolean = false;

        Start(): void {
          // Untracked dispatch: at this point, only EarlyBox is in allInlineInstances
          // (single-pass). With 2-pass, LateBox is also included.
          const x: IBox = this.flag ? this.early : this.getLate();
          Debug.Log(x.val);
          // LateBox constructor call — appears AFTER the dispatch in source order
        }

        getLate(): IBox {
          return new LateBox(2);  // LateBox first constructor call
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    // Both classes must be in the dispatch
    const tacLines = result.tac;
    expect(tacLines).toMatch(/__inst_EarlyBox_\d+__handle/);
    expect(tacLines).toMatch(/__inst_LateBox_\d+__handle/);
    // No EXTERN for IBox.val
    expect(result.uasm).not.toMatch(/IBox\.__get_val/);
  });

  it("vifaceCounter does not shift instanceCounter across passes (for-of + forward-ref)", () => {
    // IMeld is an all-inline interface iterated with for-of in Start().
    // Meld's constructor only appears in getMeld(), which is compiled AFTER Start().
    //
    // In pass 1: classIds == null → for-of falls through; Meld constructor uses
    //   instanceCounter=0 → __inst_Meld_0.
    // In pass 2 (old code): viface block fires, consuming instanceCounter=0 →
    //   __viface_IMeld_0, then Meld constructor uses instanceCounter=1 →
    //   __inst_Meld_1.  The pre-seeded entry says prefix "__inst_Meld_0", so the
    //   viface copy targets a never-written slot — silent wrong dispatch.
    // In pass 2 (fixed code): viface block uses vifaceCounter (separate), so
    //   Meld constructor still uses instanceCounter=0 → __inst_Meld_0, matching
    //   the pre-seeded allInlineInstances entry.
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

      interface IMeld { type: number; }

      class Meld implements IMeld {
        type: number;
        constructor(t: number) { this.type = t; }
      }

      @UdonBehaviour()
      export class VifaceCounterTest extends UdonSharpBehaviour {
        private melds: IMeld[] = [];

        Start(): void {
          // for-of viface dispatch fires in pass 2 (before Meld constructor seen
          // in single-pass order). vifaceCounter must not shift instanceCounter.
          for (const m of this.melds) {
            Debug.Log(m.type);
          }
        }

        Init(): void {
          // Meld constructor — appears AFTER Start() in source order.
          // In pass 2 its instanceCounter must be 0 (not 1).
          this.melds = [this.getMeld()];
        }

        getMeld(): IMeld {
          return new Meld(3);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    // The viface dispatch must copy from __inst_Meld_0_type for the first instance
    // (instanceId=1). If instanceCounter was shifted by the viface block, pass 2
    // would generate __inst_Meld_1 for the first instance and the pre-seeded
    // allInlineInstances entry {1 → prefix "__inst_Meld_0"} would reference an
    // unwritten slot.  The TAC line below confirms the copy source is _0 (not _1).
    expect(result.tac).toMatch(/__viface_IMeld_0_type = __inst_Meld_0_type/);

    // The viface prefix should be __viface_IMeld_0 (vifaceCounter starts at 0).
    expect(result.tac).toMatch(/__viface_IMeld_0_type/);

    // No EXTERN for IMeld.type
    expect(result.uasm).not.toMatch(/IMeld\.__get_type/);
  });
});
