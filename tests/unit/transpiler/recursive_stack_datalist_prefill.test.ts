/**
 * Regression test for issue 2026-05-09T133000-recursive-stack-datalist-token-restore.
 *
 * Recursive inline-method stack init was prefilling every per-local DataList
 * stack with the same `DataToken.op_Implicit__SystemDouble(0)` token,
 * regardless of the local's actual type. For DataList-typed locals (e.g.
 * mahjong `koutsuTiles`, `subResults`), the pop site emits
 * `DataToken.__get_DataList__` against `stack[sp]`. If pop ever read a
 * slot that was never pushed (or a slot whose stored DataList wrap
 * produced a non-DataList token), the VM crashed on `__get_DataList__`
 * applied to a Double token.
 *
 * Fix: prefill each per-local stack with a token whose VRC `TokenType`
 * matches the unwrap accessor selected by `unwrapDataToken` for the
 * local's TypeSymbol. For DataList/Array locals, that means constructing
 * a fresh empty DataList and wrapping it via
 * `DataToken.__ctor__VRCSDK3DataDataList` so the slot carries a
 * `TokenType.DataList` token from the start.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

beforeAll(() => {
  buildExternRegistryFromFiles([]);
});

describe("inline recursive stack — DataList prefill (issue 2026-05-09T133000)", () => {
  it("static recursion: each DataList-typed stack gets a DataList-wrapped prefill token", () => {
    // Static inline recursion with a DataList parameter and a DataList
    // local. Each per-local stack should be prefilled with a token whose
    // TokenType matches the local's TypeSymbol — DataList for items and
    // subTiles, Int32 for depth.
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { DataList } from "@ootr/udon-assembly-ts/stubs/UdonTypes";

      class Helper {
        static recurse(items: DataList, depth: number): DataList {
          const subTiles: DataList = new DataList();
          if (depth <= 0) return subTiles;
          const r: DataList = Helper.recurse(items, depth - 1);
          return subTiles;
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const list: DataList = new DataList();
          Helper.recurse(list, 3);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });
    const tac = result.tac;

    // Per-local prefill: each stack's first Add() must reference a token
    // built from the type-correct constructor. Match the line that creates
    // the wrapping token and assert the right ctor was used.
    function tokenCtorForStack(stackName: string): string | undefined {
      // Find the line that creates the stack DataList itself …
      const stackLine = `${stackName} = call VRCSDK3DataDataList.__ctor____VRCSDK3DataDataList()`;
      const stackIdx = tac.indexOf(stackLine);
      if (stackIdx < 0) return undefined;
      // … then look at the next ctor lines until the first Add(). The
      // wrap-token line names a fresh temp via DataToken.<ctor or
      // op_Implicit>(...). Capture the extern name.
      const after = tac.slice(stackIdx + stackLine.length);
      // TAC ctor lines are `VRCSDK3DataDataToken.__ctor__<Param>__VRCSDK3DataDataToken(...)`
      // Capture just the `__ctor__<Param>` / `__op_Implicit__<Param>` portion.
      const m =
        /VRCSDK3DataDataToken\.(__ctor__[A-Za-z0-9]+|__op_Implicit__[A-Za-z0-9]+)__VRCSDK3DataDataToken/.exec(
          after.slice(0, after.indexOf(`call ${stackName}.Add(`)),
        );
      return m?.[1];
    }

    expect(tokenCtorForStack("__inlineRec_Helper_recurse_stack_items")).toBe(
      "__ctor__VRCSDK3DataDataList",
    );
    expect(
      tokenCtorForStack("__inlineRec_Helper_recurse_stack_subTiles"),
    ).toBe("__ctor__VRCSDK3DataDataList");
    expect(tokenCtorForStack("__inlineRec_Helper_recurse_stack_r")).toBe(
      "__ctor__VRCSDK3DataDataList",
    );
    // `number` parameter maps to Double; prefill goes via op_Implicit
    // (UdonSharp ships a registered-but-broken Single ctor, so wrapDataToken
    // routes both Single/Double through op_Implicit).
    expect(tokenCtorForStack("__inlineRec_Helper_recurse_stack_depth")).toBe(
      "__op_Implicit__SystemDouble",
    );
  });

  it("instance recursion: DataList local stack prefilled with DataList token", () => {
    // Instance-method inline recursion path (emitInlineRecursiveInstanceMethod)
    // — separate code path from the static method but same bug, same fix.
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { DataList } from "@ootr/udon-assembly-ts/stubs/UdonTypes";

      class Walker {
        walk(items: DataList, depth: number): DataList {
          const collected: DataList = new DataList();
          if (depth <= 0) return collected;
          const sub: DataList = this.walk(items, depth - 1);
          return collected;
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const w = new Walker();
          w.walk(new DataList(), 3);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });
    const tac = result.tac;

    // Verify the prefill ctor for each declared DataList local on the
    // instance-method recursion path.
    function tokenCtorForStack(stackName: string): string | undefined {
      const stackLine = `${stackName} = call VRCSDK3DataDataList.__ctor____VRCSDK3DataDataList()`;
      const stackIdx = tac.indexOf(stackLine);
      if (stackIdx < 0) return undefined;
      const after = tac.slice(stackIdx + stackLine.length);
      // TAC ctor lines are `VRCSDK3DataDataToken.__ctor__<Param>__VRCSDK3DataDataToken(...)`
      // Capture just the `__ctor__<Param>` / `__op_Implicit__<Param>` portion.
      const m =
        /VRCSDK3DataDataToken\.(__ctor__[A-Za-z0-9]+|__op_Implicit__[A-Za-z0-9]+)__VRCSDK3DataDataToken/.exec(
          after.slice(0, after.indexOf(`call ${stackName}.Add(`)),
        );
      return m?.[1];
    }

    expect(tokenCtorForStack("__inlineRecInst_Walker_walk_stack_items")).toBe(
      "__ctor__VRCSDK3DataDataList",
    );
    expect(
      tokenCtorForStack("__inlineRecInst_Walker_walk_stack_collected"),
    ).toBe("__ctor__VRCSDK3DataDataList");
    expect(tokenCtorForStack("__inlineRecInst_Walker_walk_stack_sub")).toBe(
      "__ctor__VRCSDK3DataDataList",
    );
    // The synthesized `selfCallResult_0` slot has the method's return
    // type (DataList) — its prefill must also be a DataList token, since
    // emitInlineRecursivePop unwraps it via .DataList.
    expect(
      tokenCtorForStack(
        "__inlineRecInst_Walker_walk_stack___inlineRecInst_Walker_walk_selfCallResult_0",
      ),
    ).toBe("__ctor__VRCSDK3DataDataList");
  });
});
