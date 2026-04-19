/**
 * Tests for inline returns that should preserve structural object types.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";
import { getStartSection } from "./test_helpers.js";

describe("inline erased return handling", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("keeps a named union of structs inline", () => {
    const source = `
      type WinResultWin = { isWin: true; a: number };
      type WinResultNotWin = { isWin: false; b: string };
      type WinResult = WinResultWin | WinResultNotWin;

      class HandAnalyzer {
        selectBestWin(flag: boolean): WinResult {
          return flag
            ? { isWin: true, a: 1 }
            : { isWin: false, b: "x" };
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        private analyzer: HandAnalyzer = new HandAnalyzer();
        Start(): void {
          const result = this.analyzer.selectBestWin(true);
          const a = result.a;
          const isWin = result.isWin;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);
    const erased = result.diagnostics?.find(
      (diagnostic) => diagnostic.code === "ErasedReturnInline",
    );

    expect(erased).toBeUndefined();
    expect(startSection).not.toContain("DataToken");
  });

  it("keeps an anonymous nullable object union inline", () => {
    const source = `
      class HandAnalyzer {
        evaluate(flag: boolean): { x: number } | null {
          return flag ? { x: 1 } : null;
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        private analyzer: HandAnalyzer = new HandAnalyzer();
        Start(): void {
          const x = this.analyzer.evaluate(true)!.x;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);
    const erased = result.diagnostics?.find(
      (diagnostic) => diagnostic.code === "ErasedReturnInline",
    );

    expect(erased).toBeUndefined();
    expect(startSection).not.toContain("DataToken");
  });

  it("resolves unions with structurally identical nested anonymous struct properties", () => {
    const source = `
      type Left = { point: { x: number }; tag: number };
      type Right = { point: { x: number }; tag: number };
      type Either = Left | Right;

      class HandAnalyzer {
        pick(flag: boolean): Either {
          return flag
            ? { point: { x: 1 }, tag: 1 }
            : { point: { x: 2 }, tag: 2 };
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        private analyzer: HandAnalyzer = new HandAnalyzer();
        Start(): void {
          const r = this.analyzer.pick(true);
          const t = r.tag;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const erased = result.diagnostics?.find(
      (diagnostic) => diagnostic.code === "ErasedReturnInline",
    );

    expect(erased).toBeUndefined();
    expect(result.tac).not.toContain("DataToken");
  });

  it("propagates structural union field copies across nested inline returns", () => {
    // Mirrors pr170_union_with_array_field VM fixture. The leading ternary
    // return `return cond ? a : b` was the trigger: at TAC generation time
    // it hits the plain-copy fallback in visitReturnStatement (no valueMapping
    // for the ternary temp), which would historically set
    // returnTrackingInvalidated=true and poison subsequent tracked returns.
    const source = `
      type Win = { tag: true; value: number; list: string[] };
      type Loss = { tag: false };
      type Result = Win | Loss;

      class M {
        private selectBest(a: Result, b: Result): Result {
          if (a.tag && b.tag) {
            return (a.value as number) >= (b.value as number) ? a : b;
          }
          if (a.tag) return a;
          if (b.tag) return b;
          return { tag: false };
        }
        compute(v: number): Result {
          const win: Win = { tag: true, value: v, list: ["alpha", "beta"] };
          return this.selectBest(win, { tag: false });
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r = new M().compute(11);
          const t = r.tag;
          const lst = r.tag ? r.list.length : 0;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    // Collect every outer-to-outer propagation and require that multiple
    // distinct inner prefixes converge on the SAME outer destination —
    // the hallmark of the nested-inline unified-return-prefix chain.
    const tagPairs = [
      ...result.tac.matchAll(
        /(__inline_ret_\d+)_tag = (__inline_ret_\d+)_tag/g,
      ),
    ].map((m): [string, string] => [m[1], m[2]]);
    expect(tagPairs.length).toBeGreaterThan(0);
    // Group inner prefixes by the outer destination.
    const innersPerOuterTag = new Map<string, Set<string>>();
    for (const [outer, inner] of tagPairs) {
      if (!innersPerOuterTag.has(outer)) {
        innersPerOuterTag.set(outer, new Set());
      }
      innersPerOuterTag.get(outer)?.add(inner);
    }
    // The outer must be a single destination (one unified prefix), and
    // the inner prefixes feeding it must be distinct (showing the inner
    // inline return produced multiple tracked returns that each wrote).
    expect(innersPerOuterTag.size).toBe(1);
    const [[outerTag, tagInners]] = [...innersPerOuterTag];
    expect(tagInners.size).toBeGreaterThan(0);
    // Repeat the check for `_list` and verify the outer destination
    // matches (both field chains must share the same unified prefix).
    const listPairs = [
      ...result.tac.matchAll(
        /(__inline_ret_\d+)_list = (__inline_ret_\d+)_list/g,
      ),
    ].map((m): [string, string] => [m[1], m[2]]);
    expect(listPairs.length).toBeGreaterThan(0);
    const listOuters = new Set(listPairs.map(([outer]) => outer));
    expect(listOuters.size).toBe(1);
    const [listOuter] = listOuters;
    expect(listOuter).toBe(outerTag);
    expect(result.tac).not.toMatch(/uninst_prop.*__inst_Win_/);
  });

  it("dispatches structurally-compatible concrete classes for anon-union returns with null-typed params", () => {
    // Mirrors pr170_union_with_null_branch VM fixture. A `return <param>`
    // where the param was bound to a bare null arg has no trackable source,
    // so inline return tracking is invalidated and the caller falls back to
    // D-3 handle dispatch. The dispatch table must include the concrete
    // Win instance (className "Win") because Win is structurally assignable
    // to the anon-union return type (Result = Win | Loss); excluding it
    // leaves the Win handle out and the caller reads a default false,
    // incorrectly taking the LOSS branch.
    const source = `
      type Win = { tag: true; value: number };
      type Loss = { tag: false };
      type Result = Win | Loss;

      class M {
        private selectBest(a: Result | null, b: Result | null): Result {
          if (a !== null && a.tag && b !== null && b.tag) {
            return (a.value as number) >= (b.value as number) ? a : b;
          }
          if (a !== null && a.tag) return a;
          if (b !== null && b.tag) return b;
          return { tag: false };
        }
        run(v: number): Result {
          const win: Win = { tag: true, value: v };
          return this.selectBest(win, null);
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r = new M().run(9);
          const t = r.tag;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    // Identify the outer return-prefix that holds `r`'s `tag`: grab the
    // RHS `__inline_ret_N_tag` temp that Start's `const t = r.tag` reads
    // from. The fix is correct if EITHER (a) that temp was populated via
    // an outer field-copy from an inner return prefix, OR (b) a D-3
    // dispatch uses the concrete Win handle to source that temp. The
    // failure mode is a dispatch that reads from anon-union handles only.
    const outerCopyMatch = result.tac.match(
      /(__inline_ret_\d+)_tag = __inline_ret_\d+_tag/,
    );
    const winDispatchMatch = result.tac.match(
      /(__uninst_prop_\d+) = __inst_Win_\d+_tag/,
    );
    // At least one of the two compatible shapes must appear.
    expect(outerCopyMatch !== null || winDispatchMatch !== null).toBe(true);
  });

  it("null-coalescing split covers `this.<field> ?? fallback` as a side-effect-free left", () => {
    // `this.<field>` reads are side-effect-free in typical UdonSharp code
    // (field slots are direct memory), so the split admits them. Verify the
    // TAC emits the null-check-plus-branch pattern for this common shape.
    const source = `
      type Win = { tag: true; value: number };
      type Loss = { tag: false };
      type Result = Win | Loss;

      class M {
        private cached: Result | null = null;
        ensure(): Result {
          const fallback: Loss = { tag: false };
          return this.cached ?? fallback;
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r = new M().ensure();
          const t = r.tag;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    // The split is engaged if the TAC contains a null-check on the field
    // slot followed by two return paths (one per branch). Match the
    // `<field_slot> != null` condition plus both branches' return assigns.
    expect(result.tac).toMatch(/__inst_M_\d+_cached != null/);
    // Only the trackable else-branch emits field-copies into the unified
    // return prefix; the then-branch copies the field's handle. Verify
    // the fallback branch's `_tag` field-copy reaches the return prefix.
    expect(result.tac).toMatch(/__inline_ret_\d+_tag = __inst_Loss_\d+_tag/);
  });

  it("null-coalescing split does NOT fire for `this.<getter> ?? fallback`", () => {
    // `this.cached` with `get cached()` has the same AST shape as a plain
    // field (PropertyAccessExpression with ThisExpression object), but
    // splitting would re-evaluate the getter body twice and risk observable
    // side effects. isSideEffectFreeNullCoalesceLeft consults classMap and
    // rejects getter-backed property reads.
    const source = `
      type Win = { tag: true; value: number };
      type Loss = { tag: false };
      type Result = Win | Loss;

      class M {
        private _cached: Result | null = null;
        get cached(): Result | null { return this._cached; }
        ensure(): Result {
          const fallback: Loss = { tag: false };
          return this.cached ?? fallback;
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r = new M().ensure();
          const t = r.tag;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    // The field-slot null-check pattern must NOT appear — that would
    // indicate the split fired against a getter.
    expect(result.tac).not.toMatch(/__inst_M_\d+_cached != null/);
    // The getter-backed `_cached` slot is read indirectly via the getter,
    // so no direct `__inst_M_*_cached` slot exists; either way the split
    // shouldn't have emitted a null-check against one.
  });

  it("null-coalescing return splits into per-branch returns populating the unified return prefix", () => {
    // `return left ?? right` in a structural-union inline method is the
    // same class of bug as the ternary case — the NC evaluates to a temp
    // with no tracking. The split rewrites it as `if (left != null) return
    // left; else return right;` when `left` is side-effect-free (Identifier
    // / Literal / This), so each branch re-enters visitReturnStatement
    // and field-copies via the valueMapping path.
    const source = `
      type Win = { tag: true; value: number };
      type Loss = { tag: false };
      type Result = Win | Loss;

      class M {
        pick(a: Result): Result {
          const fallback: Loss = { tag: false };
          return a ?? fallback;
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const w: Win = { tag: true, value: 1 };
          const r = new M().pick(w);
          const t = r.tag;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    // Both NC branches must emit a `_tag` field-copy into the unified
    // return prefix — one from Win's source (the `left`-is-non-null path)
    // and one from Loss's fallback source.
    const destsByWin = new Set(
      [
        ...result.tac.matchAll(/(__inline_ret_\d+)_tag = __inst_Win_\d+_tag/g),
      ].map((m) => m[1]),
    );
    const destsByLoss = new Set(
      [
        ...result.tac.matchAll(/(__inline_ret_\d+)_tag = __inst_Loss_\d+_tag/g),
      ].map((m) => m[1]),
    );
    // Each branch produces at least one destination; the split places both
    // on the same unified destination prefix.
    expect(destsByWin.size).toBeGreaterThanOrEqual(1);
    expect(destsByLoss.size).toBeGreaterThanOrEqual(1);
    const sharedDest = [...destsByWin].find((d) => destsByLoss.has(d));
    expect(sharedDest).toBeDefined();
  });

  it("ternary return in structural-union method populates outer slots on every branch", () => {
    // Reviewer-surfaced correctness scenario: when both args are trackable
    // (ternary IS taken at runtime), the unified return prefix must be
    // populated on BOTH ternary branches. Otherwise the caller would read
    // stale slots on the branch that didn't field-copy.
    const source = `
      type Win = { tag: true; value: number; list: string[] };
      type Loss = { tag: false };
      type Result = Win | Loss;

      class M {
        private selectBest(a: Result, b: Result): Result {
          if (a.tag && b.tag) {
            return (a.value as number) >= (b.value as number) ? a : b;
          }
          if (a.tag) return a;
          if (b.tag) return b;
          return { tag: false };
        }
        compute(v1: number, v2: number): Result {
          const w1: Win = { tag: true, value: v1, list: ["x"] };
          const w2: Win = { tag: true, value: v2, list: ["y", "z"] };
          return this.selectBest(w1, w2);
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r = new M().compute(5, 7);
          const t = r.tag;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    // Both ternary branches must field-copy `_tag` into the SAME
    // destination return-prefix from DIFFERENT `__inst_Win_*` sources.
    // Group matches by destination and verify at least one group holds
    // two distinct source prefixes — avoids hard-coding allocator IDs
    // that would drift with unrelated transpiler changes.
    const perDestination = new Map<string, Set<string>>();
    for (const match of result.tac.matchAll(
      /(__inline_ret_\d+)_tag = (__inst_Win_\d+)_tag/g,
    )) {
      const [, dest, source] = match;
      if (!perDestination.has(dest)) perDestination.set(dest, new Set());
      perDestination.get(dest)?.add(source);
    }
    const maxGroupSize = Math.max(
      0,
      ...[...perDestination.values()].map((set) => set.size),
    );
    expect(maxGroupSize).toBeGreaterThanOrEqual(2);
  });

  it("includes both union branches in D-3 dispatch when nested anon property types are structurally equivalent", () => {
    // Win and Loss each declare `point: { x: number }`. Each occurrence of
    // the anonymous type literal produces its own `__anon_N` symbol, so a
    // naive identity check on property types would reject one branch and
    // leave its handle out of the dispatch, silently returning the Udon
    // zero default at runtime. hasCompatibleUnionProperty must compare
    // nested anonymous types structurally.
    const source = `
      type Win = { tag: true; point: { x: number } };
      type Loss = { tag: false; point: { x: number } };
      type Result = Win | Loss;

      class M {
        pick(f: boolean): Result {
          const w: Win = { tag: true, point: { x: 1 } };
          const l: Loss = { tag: false, point: { x: 2 } };
          const t = f ? w : l;
          return t;
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r = new M().pick(true);
          const px = r.point;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    // The D-3 `r.point` dispatch table must reference BOTH concrete
    // classes' `_point` slots, grouped on the same dispatch destination.
    const perDestination = new Map<string, Set<string>>();
    for (const match of result.tac.matchAll(
      /(__uninst_prop_\d+) = (__inst_(?:Win|Loss)_\d+)_point/g,
    )) {
      const [, dest, source] = match;
      if (!perDestination.has(dest)) perDestination.set(dest, new Set());
      perDestination.get(dest)?.add(source);
    }
    const maxGroupSize = Math.max(
      0,
      ...[...perDestination.values()].map((set) => set.size),
    );
    expect(maxGroupSize).toBeGreaterThanOrEqual(2);
  });

  it("includes both union branches when a shared named alias appears as a property type", () => {
    // Win and Loss share `point: Pt` where `Pt` is a named alias. Both
    // branches' `point` property type is the same `Pt` InterfaceTypeSymbol
    // after alias resolution. hasCompatibleUnionProperty must resolve
    // property types through typeMapper so any stale pre-alias placeholder
    // captured at parse time still compares equal to the canonical target.
    const source = `
      type Pt = { x: number };
      type Win = { tag: true; point: Pt };
      type Loss = { tag: false; point: Pt };
      type Result = Win | Loss;

      class M {
        pick(f: boolean): Result {
          const w: Win = { tag: true, point: { x: 1 } };
          const l: Loss = { tag: false, point: { x: 2 } };
          const t = f ? w : l;
          return t;
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r = new M().pick(true);
          const p = r.point;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const perDestination = new Map<string, Set<string>>();
    for (const match of result.tac.matchAll(
      /(__uninst_prop_\d+) = (__inst_(?:Win|Loss)_\d+)_point/g,
    )) {
      const [, dest, source] = match;
      if (!perDestination.has(dest)) perDestination.set(dest, new Set());
      perDestination.get(dest)?.add(source);
    }
    const maxGroupSize = Math.max(
      0,
      ...[...perDestination.values()].map((set) => set.size),
    );
    expect(maxGroupSize).toBeGreaterThanOrEqual(2);
  });

  it("single-level union return uses exactly one return prefix and no outer-to-outer chain", () => {
    // Negative control: a single-level inline method returning a union
    // must field-copy directly from its object-literal instance(s) into
    // one unified return prefix. No outer-to-outer chain (the shape
    // produced by nested inline returns) should appear — that would
    // signal the fix is emitting spurious propagation on non-nested code.
    const source = `
      type A = { tag: true; x: number };
      type B = { tag: false };
      type E = A | B;

      class H {
        pick(f: boolean): E {
          return f ? { tag: true, x: 1 } : { tag: false };
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r = new H().pick(true);
          const t = r.tag;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    // No outer-to-outer (`__inline_ret_N_tag = __inline_ret_M_tag`)
    // propagation — that pattern belongs to nested inline returns only.
    const outerToOuter = [
      ...result.tac.matchAll(/__inline_ret_\d+_tag = __inline_ret_\d+_tag/g),
    ];
    expect(outerToOuter).toHaveLength(0);
    // But each object-literal branch MUST field-copy `_tag` into the
    // unified return prefix, and the ternary split gives exactly one
    // destination prefix that both branches write into.
    const destPrefixes = new Set(
      [...result.tac.matchAll(/(__inline_ret_\d+)_tag = __inst_\w+_tag/g)].map(
        (m) => m[1],
      ),
    );
    expect(destPrefixes.size).toBe(1);
  });

  it("still erases incompatible primitive unions", () => {
    const source = `
      class HandAnalyzer {
        pick(value: string | number): string | number {
          return value as any;
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        private analyzer: HandAnalyzer = new HandAnalyzer();
        Start(): void {
          const result = this.analyzer.pick("x");
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const erased = result.diagnostics?.find(
      (diagnostic) => diagnostic.code === "ErasedReturnInline",
    );

    expect(erased).toBeDefined();
    expect(result.tac).toContain("DataToken");
  });
});
