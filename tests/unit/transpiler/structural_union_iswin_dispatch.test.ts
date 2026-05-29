/**
 * Regression tests for the structural-union SystemObject.__get_isWin bug.
 *
 * When a method returning a structural union (StandardWin | ChiitoitsuWin)
 * has one return path that is untracked (NC with method-call LHS) and one
 * that is tracked (literal), the caller's property access on `.isWin` must
 * NOT emit `SystemObject.__get_isWin__SystemBoolean`.  That extern is invalid
 * and Unity rejects it at runtime with NotSupportedException.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";
import type { DispatchLimitResolver } from "../../../src/transpiler/ir/ast_to_tac/dispatch_limit_resolver.js";

describe("structural union isWin dispatch", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("unwraps structural type-alias array elements as inline handles", () => {
    // Repro for HandAnalyzer.selectBestDecompositionByFu:
    // `WinDecomposition` is a structural type alias, not an anonymous
    // `__anon_*` interface. Array/DataList iteration must still unwrap elements
    // via DataToken.Int because object literals are stored as inline handles.
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

      type Rec = { value: number };

      class Factory {
        static make(): Rec[] {
          return [{ value: 1 }];
        }
      }

      @UdonBehaviour()
      export class StructuralAliasArrayTest extends UdonSharpBehaviour {
        Start(): void {
          const records = Factory.make();
          for (const record of records) {
            Debug.Log(record.value);
          }
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    expect(result.uasm).toMatch(/VRCSDK3DataDataToken\.__get_Int__SystemInt32/);
    expect(result.uasm).not.toMatch(
      /VRCSDK3DataDataToken\.__get_Reference__SystemObject/,
    );
  });

  it("keeps nullable structural map values as Int32 inline handles", () => {
    // Repro for YakuRegistry.get(name): Map<string, IYaku>.get(name) ?? null
    // must preserve the Int32 handle representation. If the nullish result is
    // widened to SystemObject, later D3 method dispatch compares a converted
    // object value that does not match the concrete inline instance handle.
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

      type IWorker = {
        readonly name: string;
        check(): boolean;
      };

      class AWorker {
        readonly name: string = "a";
        check(): boolean {
          return true;
        }
      }

      class Registry {
        private workers: Map<string, IWorker> = new Map();
        constructor() {
          this.workers.set("a", new AWorker());
        }
        get(name: string): IWorker | null {
          return this.workers.get(name) ?? null;
        }
      }

      @UdonBehaviour()
      export class StructuralMapNullableHandleTest extends UdonSharpBehaviour {
        Start(): void {
          const registry = new Registry();
          const worker = registry.get("a");
          if (worker !== null) {
            Debug.Log(worker.check());
          }
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    expect(result.uasm).toMatch(/VRCSDK3DataDataToken\.__get_Int__SystemInt32/);
    expect(result.uasm).toMatch(
      /SystemInt32\.__op_Equality__SystemInt32_SystemInt32__SystemBoolean/,
    );
    expect(result.uasm).not.toMatch(/SystemDataDictionary/);
    expect(result.uasm).not.toMatch(
      /SystemConvert\.__ToInt32__SystemObject__SystemInt32/,
    );
  });

  it("keeps optional calls on nullable structural map values as Int32 inline handles", () => {
    // Repro for HandAnalyzer.getWinDecomposition:
    // `const yaku = registry.get("x"); yaku?.check()` must not route the
    // optional-call receiver through a SystemObject temp, because D3 dispatch
    // compares concrete inline handles as Int32 values.
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

      type IWorker = {
        readonly name: string;
        check(): boolean;
      };

      class AWorker {
        readonly name: string = "a";
        check(): boolean {
          return true;
        }
      }

      @UdonBehaviour()
      export class StructuralMapOptionalCallHandleTest extends UdonSharpBehaviour {
        Start(): void {
          const worker: IWorker = new AWorker();
          Debug.Log(worker?.check() ?? false);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    expect(result.uasm).toMatch(/__opt_call_base_\d+: %SystemInt32/);
    expect(result.uasm).toMatch(
      /SystemInt32\.__op_Inequality__SystemInt32_SystemInt32__SystemBoolean/,
    );
    expect(result.uasm).not.toMatch(
      /SystemConvert\.__ToInt32__SystemObject__SystemInt32/,
    );
  });

  it("matches virtual interface for-of elements against SoA handles", () => {
    // Repro for YakuEvaluator.buildOrderedYakuList:
    // Map<string, IYaku>.values() returns stored inline handles for SoA-backed
    // yaku instances. The virtual-interface loop setup must compare against the
    // concrete `__handle` variables, not the small non-SoA instance ids.
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

      interface IWorker {
        readonly name: string;
        check(): boolean;
      }

      class AWorker implements IWorker {
        readonly name: string = "a";
        check(): boolean {
          return true;
        }
      }

      class BWorker implements IWorker {
        readonly name: string = "b";
        check(): boolean {
          return true;
        }
      }

      class Registry {
        private workers: Map<string, IWorker> = new Map();
        constructor() {
          for (let i = 0; i < 1; i++) {
            const worker: IWorker = new AWorker();
            this.workers.set(worker.name, worker);
          }
          for (let i = 0; i < 1; i++) {
            const worker: IWorker = new BWorker();
            this.workers.set(worker.name, worker);
          }
        }
        getAll(): IWorker[] {
          return Array.from(this.workers.values());
        }
      }

      @UdonBehaviour()
      export class VirtualInterfaceForOfSoAHandleTest extends UdonSharpBehaviour {
        Start(): void {
          const registry = new Registry();
          const workers = registry.getAll();
          for (const worker of workers) {
            Debug.Log(worker.check());
          }
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    expect(result.uasm).toMatch(/worker: %SystemInt32/);
    expect(result.uasm).not.toMatch(/worker: %SystemObject/);
    expect(result.uasm).toMatch(
      /PUSH, __viface_IWorker_\d+__classId[\s\S]{0,1200}PUSH, __inst_AWorker_\d+__handle/,
    );
    expect(result.uasm).toMatch(
      /PUSH, __viface_IWorker_\d+__classId[\s\S]{0,1800}PUSH, __inst_BWorker_\d+__handle/,
    );
  });

  it("reads populated structural destructure slots before D3 property dispatch", () => {
    // Repro for yaku.check(context): the inlined check body lowers
    // `const { hand } = context` through a structural temp. Once the temp's
    // `${prefix}_hand` slot has been populated, `context.hand` must read that
    // slot directly instead of treating the temp handle as an untracked
    // instance and emitting a D-3 miss path.
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

      type Hand = { id: number };
      type Context = { hand: Hand; count: number };

      class Worker {
        check(context: Context): boolean {
          const { hand } = context;
          return hand.id > 0;
        }
      }

      @UdonBehaviour()
      export class StructuralDestructureSlotReadTest extends UdonSharpBehaviour {
        Start(): void {
          const worker = new Worker();
          const result = worker.check({ hand: { id: 1 }, count: 1 });
          Debug.Log(result);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    expect(result.uasm).not.toMatch(
      /D3 dispatch miss: hand on untracked instance/,
    );
    expect(result.uasm).not.toMatch(/SystemObject\.__get_hand/);
  });

  it("reads fields on untracked SoA class parameters through the SoA field list", () => {
    // Repro for HandPropertyHelpers.identifyHandSuit(hand): helper params have
    // a concrete class type but no per-call-site inline tracking. For SoA
    // classes, `hand.tiles` must use the runtime handle to index the field
    // DataList; dispatching only against static instances seen so far can
    // leave the result null and crash on DataList.Count.
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

      class Hand {
        tiles: number[] = [];
        constructor(seed: number) {
          this.tiles = [seed, seed + 1];
        }
      }

      class Helper {
        static countTiles(hand: Hand): number {
          return hand.tiles.length;
        }
      }

      @UdonBehaviour()
      export class SoAParamFieldReadTest extends UdonSharpBehaviour {
        Start(): void {
          let selected: Hand | null = null;
          for (let i = 0; i < 2; i++) {
            selected = new Hand(i);
          }
          if (selected !== null) {
            Debug.Log(Helper.countTiles(selected));
          }
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    expect(result.uasm).toMatch(/__soa_Hand_tiles/);
    expect(result.uasm).not.toMatch(
      /PUSH, __inst_Hand_\d+__tiles[\s\S]{0,120}PUSH, __uninst_prop_/,
    );
  });

  it("does not emit DataList bounds checks for Record string-key bracket reads", () => {
    // Repro for HandAnalyzerDecompositionService.determineSequenceWaitType:
    // `Record<string, Tile[]>[suit]` must compile as a DataDictionary lookup.
    // Treating it like DataList indexing emits `suit >= 0` / `suit < Count`,
    // which resolves to unsupported SystemString comparison externs in Udon.
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

      @UdonBehaviour()
      export class RecordStringKeyBracketTest extends UdonSharpBehaviour {
        Start(): void {
          const bySuit: Record<string, number[]> = {};
          bySuit["m"] = [1, 2];
          const suit = "m";
          Debug.Log(bySuit[suit].length);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    expect(result.uasm).toMatch(
      /VRCSDK3DataDataDictionary\.__get_Item__VRCSDK3DataDataToken__VRCSDK3DataDataToken/,
    );
    expect(result.uasm).toMatch(/VRCSDK3DataDataDictionary\.__ContainsKey/);
    expect(result.uasm).not.toMatch(
      /SystemString\.__op_GreaterThanOrEqual__SystemString_SystemString__SystemBoolean/,
    );
    expect(result.uasm).not.toMatch(
      /SystemString\.__op_LessThan__SystemString_SystemString__SystemBoolean/,
    );
  });

  it("does not emit SystemObject.__get_isWin for untracked structural-union return (NC method-call LHS)", () => {
    // Repro for the yaku_yakuman / win_chiitoitsu / scoring_fu failures:
    //
    // WinAnalyzer.tryWin uses `tryGet(x) ?? fallback` where tryGet is a
    // method call (not side-effect-free). The NC split is skipped → the
    // result is an untracked Temporary → returnTrackingInvalidated=true for
    // WinAnalyzer.tryWin → its returnVar is NOT in inlineInstanceMap.
    //
    // Outer.analyze:
    //   - First return (x > 100): returns result of tryWin (untracked)
    //     → UntrackedStructuralUnionReturn → returnTrackingInvalidated=true
    //   - Last return: inline literal → if returnTrackingInvalidated is
    //     already true, field copies are NOT emitted for the return prefix
    //     → returnVar_isWin is NEVER declared in symbolTable
    //
    // In Start, `const r = Outer.analyze(200)`:
    //   sourcePrefixFromNamedSlots = false (returnVar_isWin not in symbolTable)
    //   → r goes to untrackedStructuralHandleVars, NOT inlineInstanceMap
    //   → r.isWin falls through to D3 dispatch
    //
    // D3 dispatch must succeed with the concrete win instances.
    // If it fails (missing anonUnionIface or dispatchLimit exceeded), it
    // falls through to PropertyGetInstruction → invalid EXTERN.
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

      type StandardWin = { isWin: boolean; fu: number };
      type ChiitoitsuWin = { isWin: boolean; han: number };
      type WinResult = StandardWin | ChiitoitsuWin;

      class WinChecker {
        static tryStandard(x: number): WinResult | null {
          return x > 0
            ? { isWin: true, fu: x }
            : null;
        }

        static getWin(x: number): WinResult {
          // NC with method-call LHS → isSideEffectFreeNullCoalesceLeft=false
          // → NC split skipped → result is an untracked Temporary
          // → returnTrackingInvalidated=true for getWin
          return WinChecker.tryStandard(x) ?? { isWin: false, han: 0 };
        }
      }

      class Outer {
        static analyze(x: number): WinResult {
          const result = WinChecker.getWin(x);
          if (x > 100) {
            return result; // UntrackedStructuralUnionReturn
          }
          return { isWin: true, han: 7 }; // tracked sibling
        }
      }

      @UdonBehaviour()
      export class IsWinDispatchTest extends UdonSharpBehaviour {
        Start(): void {
          const r1 = Outer.analyze(50);
          Debug.Log(r1.isWin);

          const r2 = Outer.analyze(200);
          Debug.Log(r2.isWin);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    // Must not emit the invalid SystemObject extern that Unity rejects.
    expect(result.uasm).not.toMatch(/SystemObject\.__get_isWin__SystemBoolean/);
    // Must not emit a PropertyGetInstruction for isWin on a SystemObject handle.
    expect(result.uasm).not.toMatch(/__get_isWin/);
  });

  it("does not emit SystemObject.__get_isWin via param-forwarding path", () => {
    // Covers the saveAndBindInlineParams propagation path:
    // an already-untracked local is forwarded through a parameter and
    // returned directly from the callee. The property access on the
    // outer result must still not produce SystemObject.__get_isWin.
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

      type StandardWin = { isWin: boolean; fu: number };
      type ChiitoitsuWin = { isWin: boolean; han: number };
      type WinResult = StandardWin | ChiitoitsuWin;

      class WinChecker {
        static tryStandard(x: number): WinResult | null {
          return x > 0 ? { isWin: true, fu: x } : null;
        }
        static getWin(x: number): WinResult {
          return WinChecker.tryStandard(x) ?? { isWin: false, han: 0 };
        }
      }

      class Wrapper {
        static wrap(p: WinResult): WinResult {
          return p;
        }
      }

      class OuterViaWrap {
        static analyzeViaWrap(x: number): WinResult {
          const result = WinChecker.getWin(x);
          if (x > 100) {
            return Wrapper.wrap(result);
          }
          return { isWin: true, han: 7 };
        }
      }

      @UdonBehaviour()
      export class IsWinWrapDispatchTest extends UdonSharpBehaviour {
        Start(): void {
          const r1 = OuterViaWrap.analyzeViaWrap(50);
          Debug.Log(r1.isWin);

          const r2 = OuterViaWrap.analyzeViaWrap(200);
          Debug.Log(r2.isWin);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    expect(result.uasm).not.toMatch(/SystemObject\.__get_isWin__SystemBoolean/);
    expect(result.uasm).not.toMatch(/__get_isWin/);
  });

  it("does not emit SystemObject.__get_isWin when dispatch limit is exceeded (regression: anonUnionIface path)", () => {
    // Regression for the production mahjong case: when the program has many
    // inline instances (> DEFAULT_DISPATCH_LIMIT = 100), the anonUnionIface
    // path populates dispInstances but dispInstances.length > dispatchLimit
    // causes the entire dispatch block to be skipped.  usedErasedFallback is
    // false for the anonUnionIface path, so the miss path inside the block
    // is also skipped → silent fallthrough to PropertyGetInstruction →
    // SystemObject.__get_isWin__SystemBoolean → NotSupportedException at
    // VRChat runtime.
    //
    // Simulated here with dispatchLimitResolver.getLimit = () => 1 so that
    // even the 3 instances in this test exceed the limit.
    const tinyResolver: DispatchLimitResolver = {
      getLimit: () => 1,
      isLargeErasedFallbackProperty: () => false,
    };
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

      type StandardWin = { isWin: boolean; fu: number };
      type ChiitoitsuWin = { isWin: boolean; han: number };
      type WinResult = StandardWin | ChiitoitsuWin;

      class WinChecker {
        static tryStandard(x: number): WinResult | null {
          return x > 0 ? { isWin: true, fu: x } : null;
        }
        static getWin(x: number): WinResult {
          return WinChecker.tryStandard(x) ?? { isWin: false, han: 0 };
        }
      }

      class Outer {
        static analyze(x: number): WinResult {
          const result = WinChecker.getWin(x);
          if (x > 100) {
            return result;
          }
          return { isWin: true, han: 7 };
        }
      }

      @UdonBehaviour()
      export class IsWinLimitTest extends UdonSharpBehaviour {
        Start(): void {
          const r = Outer.analyze(200);
          Debug.Log(r.isWin);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      dispatchLimitResolver: tinyResolver,
    });

    // Even with a tiny dispatch limit, the compiler must NOT emit the invalid
    // SystemObject extern. This branch may either reach the limit-exceeded D3
    // miss diagnostic or avoid D3 entirely by reading a propagated structural
    // field slot.
    expect(result.uasm).not.toMatch(/SystemObject\.__get_isWin__SystemBoolean/);
    expect(result.uasm).not.toMatch(/__get_isWin/);
  });

  // Skipped reproducer for the nested-inline-return boundary described in
  // 2026-05-09T013501-structural-union-object-iswin-dispatch.md (18:35 JST).
  //
  // The naive boundary-copy fix proposed in the issue (gate on
  // `untrackedStructuralHandleVars` or a populated-prefix marker) regresses
  // tenpai_param_return_batch_regression and inline_erased_return: it
  // propagates *stale* slot values past untracked execution paths — exactly
  // the case D-3 dispatch is the safety net for. A correct fix needs
  // per-path slot-population tracking (NC truthy branch must copy slots
  // from the inner inline-ret, or the boundary must know which return path
  // populated which prefix on its own branch).
  //
  it("propagates structural-prefix slots across nested inline-method returns (no SystemObject fallback)", () => {
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

      type StandardWin = { isWin: boolean; fu: number };
      type ChiitoitsuWin = { isWin: boolean; han: number };
      type WinResult = StandardWin | ChiitoitsuWin;

      class Inner {
        static maybeWin(x: number): WinResult | null {
          return x > 100 ? { isWin: true, fu: x } : null;
        }
        static getWin(x: number): WinResult {
          if (x > 0) {
            // Tracked literal: populates __inline_ret_<getWin>_isWin
            return { isWin: true, fu: x };
          }
          // NC with method-call LHS produces a temp:
          // returnTrackingInvalidated → __inline_ret_<getWin> ends up
          // in untrackedStructuralHandleVars on inline expansion exit.
          return Inner.maybeWin(x) ?? { isWin: false, han: 0 };
        }
      }

      class Middle {
        static analyze(x: number): WinResult {
          // value at this return is __inline_ret_<getWin> (Variable).
          // valueMapping is undefined; the new untrackedStructuralHandleVars
          // fallback uses the named handle as the source prefix and emits
          // the per-field boundary copies into __inline_ret_<analyze>.
          return Inner.getWin(x);
        }
      }

      @UdonBehaviour()
      export class IsWinNestedInlineReturnTest extends UdonSharpBehaviour {
        Start(): void {
          const r = Middle.analyze(50);
          Debug.Log(r.isWin);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    expect(result.uasm).not.toMatch(/SystemObject\.__get_isWin__SystemBoolean/);
    expect(result.uasm).not.toMatch(/__get_isWin/);
    // Positive assertion: the TAC must contain a boundary slot copy from
    // the inner inline-ret prefix to the outer one. Without the fix this
    // copy is never emitted (only the handle copy goes through), and the
    // outer __inline_ret_<n>_isWin slot stays uninitialised. Match a
    // direct `__inline_ret_<a>_isWin = __inline_ret_<b>_isWin` line in TAC.
    expect(result.tac).toMatch(
      /__inline_ret_\d+_isWin\s*=\s*__inline_ret_\d+_isWin/,
    );
  });
});
