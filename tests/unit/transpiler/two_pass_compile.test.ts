/**
 * Tests for Fix D-1: 2-pass compilation.
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
});
