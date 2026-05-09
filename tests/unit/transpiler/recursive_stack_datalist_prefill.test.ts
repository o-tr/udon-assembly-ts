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
 * Walk the generated TAC line-by-line, find the line that creates the
 * named stack DataList (`<stackName> = call VRCSDK3DataDataList.__ctor*`),
 * then look forward through the next few lines until the first
 * `<stackName>.Add(...)` for the matching DataToken ctor (or op_Implicit)
 * extern that produced the prefill token. Returns the captured ctor name
 * fragment (e.g. `__ctor__VRCSDK3DataDataList`,
 * `__op_Implicit__SystemDouble`) so the assertion can check it directly.
 *
 * Uses line-based scanning with whitespace-tolerant matching to remain
 * robust against formatter changes or platform-specific TAC dumping.
 */
function tokenCtorForStack(tac: string, stackName: string): string | undefined {
  const lines = tac.split("\n");
  const stackInitRe = new RegExp(
    `^\\s*${stackName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")} = call VRCSDK3DataDataList\\.__ctor`,
  );
  const addRe = new RegExp(
    `\\bcall ${stackName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\.Add\\(`,
  );
  const ctorRe =
    /VRCSDK3DataDataToken\.(__ctor__[A-Za-z0-9]+|__op_Implicit__[A-Za-z0-9]+)__VRCSDK3DataDataToken/;
  const startIdx = lines.findIndex((l) => stackInitRe.test(l));
  if (startIdx < 0) return undefined;
  // Look at the next ~10 lines for the wrap-token ctor. Stop at the first
  // Add(...) on this stack — anything past that is the prefill loop body
  // and contains no new ctor information.
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

    expect(
      tokenCtorForStack(tac, "__inlineRec_Helper_recurse_stack_items"),
    ).toBe("__ctor__VRCSDK3DataDataList");
    expect(
      tokenCtorForStack(tac, "__inlineRec_Helper_recurse_stack_subTiles"),
    ).toBe("__ctor__VRCSDK3DataDataList");
    expect(tokenCtorForStack(tac, "__inlineRec_Helper_recurse_stack_r")).toBe(
      "__ctor__VRCSDK3DataDataList",
    );
    // `number` parameter maps to Double; prefill goes via op_Implicit
    // (UdonSharp ships a registered-but-broken Single ctor, so wrapDataToken
    // routes both Single/Double through op_Implicit).
    expect(
      tokenCtorForStack(tac, "__inlineRec_Helper_recurse_stack_depth"),
    ).toBe("__op_Implicit__SystemDouble");
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

    expect(
      tokenCtorForStack(tac, "__inlineRecInst_Walker_walk_stack_items"),
    ).toBe("__ctor__VRCSDK3DataDataList");
    expect(
      tokenCtorForStack(tac, "__inlineRecInst_Walker_walk_stack_collected"),
    ).toBe("__ctor__VRCSDK3DataDataList");
    expect(
      tokenCtorForStack(tac, "__inlineRecInst_Walker_walk_stack_sub"),
    ).toBe("__ctor__VRCSDK3DataDataList");
    // The synthesized `selfCallResult_0` slot has the method's return
    // type (DataList) — its prefill must also be a DataList token, since
    // emitInlineRecursivePop unwraps it via .DataList.
    expect(
      tokenCtorForStack(
        tac,
        "__inlineRecInst_Walker_walk_stack___inlineRecInst_Walker_walk_selfCallResult_0",
      ),
    ).toBe("__ctor__VRCSDK3DataDataList");
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

    const base = "__recursionStack_RecMethodWithDataList_walk";
    // Parameters use the `___0_<name>__param` suffix in the @RecursiveMethod path.
    expect(tokenCtorForStack(tac, `${base}___0_items__param`)).toBe(
      "__ctor__VRCSDK3DataDataList",
    );
    // `number` parameter → Double op_Implicit (mirrors the inline cases).
    expect(tokenCtorForStack(tac, `${base}___0_depth__param`)).toBe(
      "__op_Implicit__SystemDouble",
    );
    // Declared DataList locals.
    expect(tokenCtorForStack(tac, `${base}_collected`)).toBe(
      "__ctor__VRCSDK3DataDataList",
    );
    expect(tokenCtorForStack(tac, `${base}_sub`)).toBe(
      "__ctor__VRCSDK3DataDataList",
    );
    // Synthesized selfCallResult slot for the recursive call's DataList return.
    expect(
      tokenCtorForStack(
        tac,
        `${base}___selfCallResult_RecMethodWithDataList_walk_0`,
      ),
    ).toBe("__ctor__VRCSDK3DataDataList");
  });
});
