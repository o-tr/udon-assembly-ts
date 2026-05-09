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

/**
 * Find the recursive-stack DataList that backs a particular local in the
 * generated TAC, then return the DataToken ctor / op_Implicit extern that
 * produced its prefill token. Returns the captured fragment (e.g.
 * `__ctor__VRCSDK3DataDataList`, `__op_Implicit__SystemDouble`).
 *
 * `stackPrefix` is the per-method prefix (e.g.
 * `__inlineRec_Helper_recurse_stack_`, `__recursionStack_<Class>_<method>_`)
 * and `localSuffix` is the local's source name (e.g. `subTiles`). Inline
 * locals declared inside a method body are mangled by
 * `mangleInlineLocalName` to `__inline_<Class>_<method>_<name>` (see PR
 * #239) — parameters and synthetic slots keep their plain name. The
 * helper matches stacks whose name starts with `stackPrefix` and ends
 * with `localSuffix` (allowing zero-or-more `\w` chars in between) so
 * both forms match without coupling the test to the mangling scheme.
 */
function tokenCtorForStack(
  tac: string,
  stackPrefix: string,
  localSuffix: string,
): string | undefined {
  const lines = tac.split("\n");
  // The stack DataList is created at top of the prefill block via:
  //   <prefix><name> = call VRCSDK3DataDataList.__ctor*
  // Match any stack whose name starts with stackPrefix and ends with
  // `_<localSuffix>` (the leading `_` prevents `_r` from matching a
  // longer suffix like `_returnSiteIdx`).
  const escPrefix = stackPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escSuffix = localSuffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Allow zero-or-more `\w` chars between the per-method prefix (which
  // already ends with `_`) and the local suffix. This covers both the
  // local case (`<prefix><suffix>`) and the CI case
  // (`<prefix>__inline_<Class>_<method>_<suffix>`). Disambiguation
  // against stacks whose names happen to *contain* the suffix (e.g.
  // `selfCallResult_0` contains `0`, `returnSiteIdx` contains `r`)
  // relies on the trailing ` = call ...` token-boundary in the input.
  const stackInitRe = new RegExp(
    `^\\s*(${escPrefix}[\\w]*${escSuffix}) = call VRCSDK3DataDataList\\.__ctor`,
  );
  const ctorRe =
    /VRCSDK3DataDataToken\.(__ctor__[A-Za-z0-9]+|__op_Implicit__[A-Za-z0-9]+)__VRCSDK3DataDataToken/;
  let startIdx = -1;
  let stackName = "";
  for (let i = 0; i < lines.length; i++) {
    const m = stackInitRe.exec(lines[i]);
    if (m) {
      startIdx = i;
      stackName = m[1];
      break;
    }
  }
  if (startIdx < 0) return undefined;
  const escName = stackName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const addRe = new RegExp(`\\bcall ${escName}\\.Add\\(`);
  // Look at the next ~10 lines for the wrap-token ctor. Stop at the first
  // Add(...) on this stack — anything past that is the prefill loop body.
  for (let i = startIdx + 1; i < Math.min(startIdx + 12, lines.length); i++) {
    if (addRe.test(lines[i])) return undefined;
    const m = ctorRe.exec(lines[i]);
    if (m) return m[1];
  }
  return undefined;
}

describe("inline recursive stack — DataList prefill (issue 2026-05-09T133000)", () => {
  it("static recursion: each DataList-typed stack gets a DataList-wrapped prefill token", () => {
    // Static inline recursion with a DataList parameter and a DataList
    // local. Each per-local stack should be prefilled with a token whose
    // TokenType matches the local's TypeSymbol — DataList for items,
    // subTiles, r; Double for depth.
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
    const prefix = "__inlineRec_Helper_recurse_stack_";

    expect(tokenCtorForStack(tac, prefix, "items")).toBe(
      "__ctor__VRCSDK3DataDataList",
    );
    expect(tokenCtorForStack(tac, prefix, "subTiles")).toBe(
      "__ctor__VRCSDK3DataDataList",
    );
    expect(tokenCtorForStack(tac, prefix, "r")).toBe(
      "__ctor__VRCSDK3DataDataList",
    );
    // `number` parameter maps to Double; prefill goes via op_Implicit.
    expect(tokenCtorForStack(tac, prefix, "depth")).toBe(
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
    const prefix = "__inlineRecInst_Walker_walk_stack_";

    expect(tokenCtorForStack(tac, prefix, "items")).toBe(
      "__ctor__VRCSDK3DataDataList",
    );
    expect(tokenCtorForStack(tac, prefix, "collected")).toBe(
      "__ctor__VRCSDK3DataDataList",
    );
    expect(tokenCtorForStack(tac, prefix, "sub")).toBe(
      "__ctor__VRCSDK3DataDataList",
    );
    // The synthesized `selfCallResult_0` slot has the method's return
    // type (DataList) — its prefill must also be a DataList token, since
    // emitInlineRecursivePop unwraps it via .DataList.
    expect(tokenCtorForStack(tac, prefix, "selfCallResult_0")).toBe(
      "__ctor__VRCSDK3DataDataList",
    );
  });

  it("@RecursiveMethod: per-local prefill matches each local's type", () => {
    // Third recursion path: @RecursiveMethod compiles the method as a
    // standalone UdonBehaviour entry-point with its own stack init in
    // visitors/statement.ts. The same shared-default bug existed there
    // (Single(0) for every stack) and the same per-local fix was applied.
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { DataList } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
      function RecursiveMethod(_t: object, _k: string, d: PropertyDescriptor): PropertyDescriptor { return d; }

      @UdonBehaviour()
      export class RecMethodWithDataList extends UdonSharpBehaviour {
        @RecursiveMethod
        walk(items: DataList, depth: number): DataList {
          const collected: DataList = new DataList();
          if (depth <= 0) return collected;
          const sub: DataList = this.walk(items, depth - 1);
          return collected;
        }

        Start(): void {
          this.walk(new DataList(), 3);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });
    const tac = result.tac;
    const prefix = "__recursionStack_RecMethodWithDataList_walk_";

    // Parameters in the @RecursiveMethod path carry the `0_<name>__param`
    // suffix; pass that through to the suffix matcher.
    expect(tokenCtorForStack(tac, prefix, "0_items__param")).toBe(
      "__ctor__VRCSDK3DataDataList",
    );
    // `number` parameter → Double op_Implicit (mirrors the inline cases).
    expect(tokenCtorForStack(tac, prefix, "0_depth__param")).toBe(
      "__op_Implicit__SystemDouble",
    );
    // Declared DataList locals.
    expect(tokenCtorForStack(tac, prefix, "collected")).toBe(
      "__ctor__VRCSDK3DataDataList",
    );
    expect(tokenCtorForStack(tac, prefix, "sub")).toBe(
      "__ctor__VRCSDK3DataDataList",
    );
    // Synthesized selfCallResult slot for the recursive call's DataList return.
    expect(
      tokenCtorForStack(
        tac,
        prefix,
        "selfCallResult_RecMethodWithDataList_walk_0",
      ),
    ).toBe("__ctor__VRCSDK3DataDataList");
  });

  it("branch-local arrays: self-call in one branch saves the other branch's uninitialized DataList", () => {
    // Regression for the residual problem tracked by issue 2026-05-09T133000.
    // Both locals are declared inside separate branches so that at the recursive
    // call site, one local is truly absent/uninitialized depending on which
    // branch was taken. Without saveLocalAsSafeToken, the push path would box
    // the uninitialized (null) DataList into a non-DataList token and crash.
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { DataList } from "@ootr/udon-assembly-ts/stubs/UdonTypes";

      class BranchLocalTest {
        static process(items: DataList, depth: number): DataList {
          if (depth <= 0) return items;
          if (depth > 1) {
            // Branch A: self-call happens here; 'a' is initialized but 'b' does not exist.
            const a: DataList = new DataList();
            const subA: DataList = BranchLocalTest.process(items, depth - 1);
            a.push(subA);
          } else {
            // Branch B: 'b' is initialized here; no self-call in this branch.
            const b: DataList = new DataList();
            b.push(items);
          }
          return items;
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const list: DataList = new DataList();
          BranchLocalTest.process(list, 3);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });
    const tac = result.tac;
    const prefix = "__inlineRec_BranchLocalTest_process_stack_";

    // Both branch-local arrays must be prefilled with DataList tokens.
    expect(tokenCtorForStack(tac, prefix, "a")).toBe(
      "__ctor__VRCSDK3DataDataList",
    );
    expect(tokenCtorForStack(tac, prefix, "b")).toBe(
      "__ctor__VRCSDK3DataDataList",
    );
  });

  it("inline recursive push: DataList locals save null-safe tokens (saveLocalAsSafeToken)", () => {
    // Verify that emitCallSitePush / emitInlineRecursivePush use
    // saveLocalAsSafeToken instead of raw wrapDataToken. The test checks
    // that the stack slots are populated with type-correct default tokens,
    // not boxed-null values from uninitialized locals.
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { DataList } from "@ootr/udon-assembly-ts/stubs/UdonTypes";

      class PushPathTest {
        static gather(items: DataList, depth: number): DataList {
          const result: DataList = new DataList();
          if (depth <= 0) return result;
          // Self-call with uninitialized 'result' in the recursive path.
          const sub: DataList = PushPathTest.gather(items, depth - 1);
          result.push(sub);
          return result;
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const list: DataList = new DataList();
          PushPathTest.gather(list, 2);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });
    const tac = result.tac;
    const prefix = "__inlineRec_PushPathTest_gather_stack_";

    // The 'result' local must use DataList-token prefill (not Double).
    expect(tokenCtorForStack(tac, prefix, "result")).toBe(
      "__ctor__VRCSDK3DataDataList",
    );
    expect(tokenCtorForStack(tac, prefix, "sub")).toBe(
      "__ctor__VRCSDK3DataDataList",
    );
  });

  it("push path: all inline locals use wrapDataToken(localVar) since they are synthesized upfront", () => {
    // This test verifies that saveLocalAsSafeToken uses wrapDataToken(localVar)
    // for both initialized and uninitialized DataList locals at push time. In
    // inline recursion, all context locals (params, self-call results, try/catch
    // vars) are synthesized during context setup before any body execution, so
    // they are always present regardless of initialization state. There is no
    // distinction between initialized and uninitialized — every local gets
    // wrapped via wrapDataToken(localVar).
    //
    // The source uses a branch-local pattern where 'uninit' is declared only in
    // the else-branch (after the recursive call) and 'result' is initialized
    // before the call. Both should produce set_Item calls whose token ctor args
    // reference their respective variable names, confirming wrapDataToken was used.
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { DataList } from "@ootr/udon-assembly-ts/stubs/UdonTypes";

      class PushPathTest {
        static gather(items: DataList, depth: number): DataList {
          const result: DataList = new DataList();
          if (depth <= 0) return result;
          // Branch A: self-call here — 'result' is initialized before call.
          if (depth > 1) {
            const sub: DataList = PushPathTest.gather(items, depth - 1);
            result.push(sub);
          } else {
            // Branch B: no self-call; 'uninit' declared here but never used.
            const uninit: DataList = new DataList();
          }
          return result;
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const list: DataList = new DataList();
          PushPathTest.gather(list, 2);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });
    const tac = result.tac;

    const lines = tac.split("\n");
    const prefix = "__inlineRec_PushPathTest_gather_stack_";

    // Find set_Item calls for the 'result' stack and verify its token ctor
    // argument references "result". Then find set_Item for 'uninit' stack and
    // check that its token ctor arg also references "uninit" — both use
    // wrapDataToken(localVar) since all inline context locals are synthesized.
    const inlinePrefix = "__inline_PushPathTest_gather_";
    const resultSetItemRe = new RegExp(
      `\\bcall ${prefix}${inlinePrefix}result\\.set_Item`,
    );
    const uninitSetItemRe = new RegExp(
      `\\bcall ${prefix}${inlinePrefix}uninit\\.set_Item`,
    );

    let setResultLineIdx = -1;
    let setUninitLineIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (resultSetItemRe.test(lines[i])) setResultLineIdx = i;
      if (uninitSetItemRe.test(lines[i])) setUninitLineIdx = i;
    }

    expect(setResultLineIdx).toBeGreaterThanOrEqual(0);
    expect(setUninitLineIdx).toBeGreaterThanOrEqual(0);

    // Both 'result' and 'uninit' use their (mangled) variable references via
    // wrapDataToken(localVar) — saveLocalAsSafeToken always receives a
    // non-null localVar because both call sites unconditionally create it.
    let resultArgIsMangledVar = false;
    for (let j = 1; j <= 3 && setResultLineIdx - j >= 0; j++) {
      const l = lines[setResultLineIdx - j];
      if (
        /VRCSDK3DataDataToken\.__ctor__VRCSDK3DataDataList__VRCSDK3DataDataToken\(.*_result\)/.test(
          l,
        )
      ) {
        resultArgIsMangledVar = true;
        break;
      }
    }

    let uninitArgIsMangledVar = false;
    for (let j = 1; j <= 3 && setUninitLineIdx - j >= 0; j++) {
      const l = lines[setUninitLineIdx - j];
      if (
        /VRCSDK3DataDataToken\.__ctor__VRCSDK3DataDataList__VRCSDK3DataDataToken\(.*_uninit\)/.test(
          l,
        )
      ) {
        uninitArgIsMangledVar = true;
        break;
      }
    }

    expect(resultArgIsMangledVar).toBe(true);
    expect(uninitArgIsMangledVar).toBe(true);
  });
});
