/**
 * Tests for the trivial-zero-param-return fast-path in inlineResolvedMethodBody.
 * The fast-path triggers for `get x() { return EXPR; }` (and equivalent zero-
 * arg methods) and skips the inline_return label + JUMP + scope/state save-
 * restore scaffolding, emitting a single COPY through `__inline_ret_*`.
 *
 * The slow path remains in place for any non-trivial body shape; these tests
 * also lock that fall-through behaviour by asserting the `inline_return` label
 * is still emitted for ineligible bodies.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry.js";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

describe("trivial-return getter fast-path", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("skips the inline_return label for a single-return zero-param getter", () => {
    const source = `
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        private _hp: number = 42;
        get hp(): number {
          return this._hp;
        }
        Start(): void {
          Debug.Log(this.hp);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });
    // The fast-path emits a single COPY into `__inline_ret_*` but no
    // `inline_return:` label, since visitReturnStatement is bypassed.
    expect(result.tac).toMatch(/__inline_ret_\d+ = _hp\b/);
    expect(result.tac).not.toMatch(/inline_return\d*:/);
  });

  it("falls through to the slow path for a multi-statement getter body", () => {
    const source = `
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        private _hp: number = 42;
        get hp(): number {
          const x = this._hp;
          return x;
        }
        Start(): void {
          Debug.Log(this.hp);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });
    // Multi-statement body fails canFastPathTrivialReturn predicate (2);
    // slow path emits the inline_return label.
    expect(result.tac).toMatch(/inline_return\d*:/);
  });

  it("falls through to the slow path for a non-zero-parameter method", () => {
    const source = `
      class Holder {
        private store: number[] = [0, 0, 0];
        getAt(i: number): number {
          return this.store[i];
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const h = new Holder();
          Debug.Log(h.getAt(1));
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });
    // 1-parameter method fails canFastPathTrivialReturn predicate (1);
    // slow path emits the inline_return label.
    expect(result.tac).toMatch(/inline_return\d*:/);
  });

  it("falls through to the slow path when the body allocates", () => {
    // `return new Vec()` would route through allocateBodyCachedInstance,
    // which keys its cache off the top of inlinedBodyStack. The fast-path
    // doesn't push the body — the eligibility predicate must reject this
    // shape so the cache stays correctly keyed.
    const source = `
      class Vec {
        x: number = 0;
      }
      class Factory {
        get fresh(): Vec {
          return new Vec();
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const f = new Factory();
          Debug.Log(f.fresh.x);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });
    expect(result.tac).toMatch(/inline_return\d*:/);
  });

  it("preserves WriteToGetter detection through the fast-path", () => {
    // The fast-path mints an `__inline_ret_*` Variable with isInlineReturn
    // so that `expression.ts` can recognise the LHS of a compound write
    // through a getter and short-circuit the silent backing-field mutation.
    const source = `
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        private _hp: number = 10;
        get hp(): number {
          return this._hp;
        }
        Start(): void {
          // @ts-ignore: write to getter-only intentionally
          this.hp += 5;
          Debug.Log(this._hp);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });
    const diagnostics = result.diagnostics ?? [];
    expect(diagnostics.some((d) => d.code === "WriteToGetter")).toBe(true);
    expect(result.tac).not.toMatch(/_hp\s*=\s*_hp\s*\+/);
  });
});
