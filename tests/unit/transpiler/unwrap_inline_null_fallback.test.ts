/**
 * Regression test for the `unwrapDataToken` null-fallback bug.
 *
 * `unwrapDataToken` in `helpers/assignment.ts` enters its inline-handle branch
 * via `isInlineHandleType`, then rewrites `targetType` from
 * `InterfaceTypeSymbol("IAlias")` to `ClassTypeSymbol("IAlias", Int32)`. A
 * second call to `isInlineHandleType` was made later to pick the null-fallback
 * constant: `-1` (the inline-handle sentinel) vs `0`. The second call's
 * ClassTypeSymbol branch checks `classMap.has(type.name)`, but `classMap` is
 * keyed by concrete class names (e.g. `"ImplA"`), not interface names — so the
 * second check returned `false`, and a null read of an inline-handle interface
 * produced `0` instead of `-1`.
 *
 * Fix: capture a sticky `isInlineHandle` flag at the first check and reuse it.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

describe("unwrapDataToken inline-handle null fallback", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("emits -1 sentinel (not 0) for a null inline-handle Map.get read", () => {
    const source = `
      type IAlias = { val: number };

      class ImplA implements IAlias {
        val: number = 42;
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        registry: Map<string, IAlias> = new Map();

        @EntryPoint()
        _start(): void {
          this.registry.set("a", new ImplA());
          const got = this.registry.get("a");
          if (got !== null) {
            Debug.Log(got.val.toString());
          }
        }
      }
    `;

    const { uasm } = new TypeScriptToUdonTranspiler().transpile(source);

    // The null-fallback scaffold at assignment.ts:768-782 emits a constant
    // assignment on the null branch, followed by the non-null label and
    // the property-get. For an inline handle, the fallback must be -1
    // (encoded as the Int32 constant `-1`).
    //
    // Locate any data-section constant declared with value `-1` at
    // %SystemInt32 — this is the sentinel expected by inline-handle
    // consumers. Presence indicates the sticky-flag fix is active.
    expect(uasm).toMatch(
      /__const_\d+_SystemInt32:\s*%SystemInt32,\s*-1(?:[^0-9]|$)/,
    );
  });

  it("does NOT emit a -1 sentinel for a nullable Map<string, number> read", () => {
    // Baseline: non-inline-handle reads continue to fall back to 0.
    // The sticky-flag fix only activates the -1 branch for inline handles.
    const source = `
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        registry: Map<string, number> = new Map();

        @EntryPoint()
        _start(): void {
          this.registry.set("a", 5);
          const got = this.registry.get("a");
          Debug.Log(got.toString());
        }
      }
    `;

    const { uasm } = new TypeScriptToUdonTranspiler().transpile(source);

    // Mirror the positive-test pattern: the null-fallback scaffold at
    // assignment.ts:768-782 emits a `_SystemInt32: %SystemInt32, -1`
    // constant declaration specifically for inline-handle reads. Assert
    // the scaffold's data-declaration shape does not appear — the
    // plain-number Map.get stores/reads Int directly and does not enter
    // the inline-handle branch.
    expect(uasm).not.toMatch(
      /__const_\d+_SystemInt32:\s*%SystemInt32,\s*-1(?:[^0-9]|$)/,
    );
  });
});
