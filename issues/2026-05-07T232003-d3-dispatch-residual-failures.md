---
created: 2026-05-07T23:20:03+09:00
updated: 2026-05-08T13:30:00+09:00
status: fixed
severity: high
component: transpiler / D3 method dispatch
related_branch: d3-dispatch-residual-failures
related_test: mahjong-t2 VM suite (post PR #217 / #218)
related_issue: 2026-05-07T024001-d3-dispatch-miss-cascade-null-result.md (closed)
sub_issue: 2026-05-08T010000-soa-handle-collision-wrong-class-dispatch.md (fixed)
---

# D3 dispatch + DataToken-Double cascade still failing ~19 tests despite #024001 closure

## Summary

Issue #024001 is marked **closed** with both Fix 1 (broader candidate
collection for erased receivers) and Fix 2 (defensive sentinel via
`dispatchResultFlags` short-circuiting `wrapDataToken`) applied and merged
(PR #217 / commit 93a008c). A mahjong-t2 VM run against this same HEAD still
shows the exact failure pattern #024001 was meant to eliminate, in roughly
the same ~19 tests it originally affected. Either the fixes have a
remaining gap, or there is a second cascade pathway that produces the
identical symptom.

## Symptom

The post-merge VM run produces, for ~19 of 26 failures:

```text
VM diagnostics:
[Error] [udon-assembly-ts] D3 method dispatch miss: check on untracked instance

Inner: UdonVMException: An exception occurred during EXTERN to
  'VRCSDK3DataDataToken.__op_Implicit__SystemDouble__VRCSDK3DataDataToken'.
```

Affected tests (sample): `hand_win_detection`, `yaku_tanyao`, `yaku_pinfu`,
`yaku_yakuhai`, `yaku_combination`, `yaku_yakuman`, `yaku_kuisagari`,
`scoring_mangan`, `scoring_tsumo`, `scoring_fu`, `score_distribution`,
`win_chiitoitsu`, `wait_types`, `yaku_sequence`, `yaku_terminal`, `yaku_suit`,
`yaku_situational`, `scoring_tiers`, `scoring_dealer`, `scoring_honba`,
`yaku_combination`, `yaku_kuisagari`, `yaku_pinfu`, `yaku_tanyao`,
`yaku_yakuhai`, `yaku_yakuman`.

Two tests crash on a different EXTERN (`DataList.__get_Count`) but with the
same D3 dispatch miss diagnostic preceding: `yaku_triplet`,
`yaku_yakuman_extra` — likely the same root cascade hitting a
`.Count`-on-null-DataList instead of the Double wrap.

## Why this is filed as a separate issue

#024001 is closed and its Fix 2 description claims "all paths covered". A
fresh issue tracks the residual cases without reopening the closed one,
since the investigation needs to determine first whether this is:

1. A bug in the existing fix (some `wrapDataToken` call site doesn't
   consult `dispatchResultFlags`, or the flag is set but reset before the
   wrap).
2. A second crash pathway that mimics #024001's symptom (e.g. the dispatch
   succeeds but the resolved candidate's return value is itself uninitialised
   for fields the caller dereferences).
3. A regression in candidate collection for the structural-union receivers
   the warnings highlight (see "D3DispatchFallback" warnings, all of which
   are on `tiles` accesses with `Hand` and the anonymous `__anon_isOpen:bool|tiles:Tile[]|type:string`
   receiver — i.e. `Meld` typed structurally).

## Where to investigate

1. **`dispatchResultFlags` lifecycle** —
   - `src/transpiler/ir/ast_to_tac/converter.ts:~304-308` (field declaration)
   - `:~666` (`resetState()` clears the map)
   - `src/transpiler/ir/ast_to_tac/visitors/call.ts:~475-478,1146-1150,1429-1433`
     (flag set sites). Verify the flag *key* matches what `wrapDataToken`
     looks up. A mismatch (different temp name / aliasing across temps) would
     silently skip the short-circuit and let the original cascade fire.
   - `src/transpiler/ir/ast_to_tac/helpers/assignment.ts:~660-669` (the
     short-circuit lookup site).
2. **D3DispatchFallback warnings on `tiles`** —
   The transpile log shows ~28 distinct warning sites, all complaining the
   `tiles` property has 2–3 candidate classes including the anonymous
   `__anon_isOpen:bool|tiles:Tile[]|type:string` shape. The dispatch
   succeeds (Fix 1 broadened candidates), but the returned value's fields
   may not align across the dispatched candidates. If the structural shape's
   `tiles` field maps to a different prefix slot than `Hand.tiles`, the
   caller reads garbage and the cascade resumes.
3. **PC of the crash** —
   The reported PCs (e.g. `0x001A2B2C`, `0x001A5B20`, `0x001A23F8`) cluster
   in a tight range, suggesting a single call site in shared yaku/scoring
   code is the actual crash point. Disassembling the .uasm at those PCs
   would identify the specific wrap that bypasses the flag check.

## Suggested first step

Re-run mahjong-t2 with full Unity log capture and dump the .uasm around the
crash PC for `hand_win_detection` (the simplest failing test). Walk back from
the crashing `__op_Implicit__SystemDouble` to the originating
`PUSH, <token-temp>` and check whether that temp's name appears as a key in
`dispatchResultFlags` set/get. If the key is missing, Fix 2's flag-tracking
has a hole; if present-but-true, Fix 2's short-circuit is being bypassed.

## Severity

High. ~19 / 38 mahjong-t2 VM tests still failing — same blast radius as
#024001 originally had — despite the closure. Strong indicator that the
existing fixes don't generalise to the structural-union / anonymous-shape
candidate set.

## Fix applied (2026-05-08)

**Root cause identified and partially fixed** in `call.ts:1487`:

The `useInterfaceInstanceIdDispatch` optimization path (second D3 dispatch loop,
for property-access method calls through interface-typed variables) was comparing
runtime handles against `createConstant(instId, ...)` instead of
`createVariable(prefix + "__handle", ...)`. For non-SoA instances these are
identical (handle is set to `instanceId` at compile time). For SoA instances,
the runtime handle is the *SoA counter value* (1, 2, …), while `instanceId` is
a globally sequential integer (5, 6, …). The comparison always missed.

**Fix**: gate the constant path on `!converter.soaClasses.has(info.className)`:
```ts
const instanceHandle =
  useInterfaceInstanceIdDispatch && !converter.soaClasses.has(info.className)
    ? createConstant(instId, PrimitiveTypes.int32)
    : createVariable(`${info.prefix}__handle`, PrimitiveTypes.int32);
```

This eliminates the `D3 method dispatch miss: check on untracked instance` log
messages. VM tests need to run to confirm how many failures are cleared.

**Remaining concern — SoA counter collision**: per-class SoA counters each start
at 1. Two instances from different SoA classes created in the same context both
get handle=1 (or handle=2 for the second of each, etc.). The dispatch loop checks
handle equality only (no class tag), so it routes every dispatch to the first
candidate whose `__handle` variable matches the runtime value — which may be the
wrong class. This doesn't produce a dispatch-miss log; it produces *wrong-class
dispatch*. Fixing this requires a class discriminator or a global counter shared
across all SoA classes. To be addressed as follow-up after VM run.

## VM verification (2026-05-08)

Full mahjong-t2 VM run after both fixes (SoA constant path guard + partition
offsets) completed with **183/183 tests passed, 0 bad externs** (baseline:
1042 bad externs, 16/38 zero-bad). All previously failing tests now pass.

## References

- Closed predecessor: `issues/2026-05-07T024001-d3-dispatch-miss-cascade-null-result.md`
- Sub-issue: `issues/2026-05-08T010000-soa-handle-collision-wrong-class-dispatch.md`
- Merge commits: 93a008c (PR #217), daed404 (PR #218)
- Test log timestamp: 2026-05-07 23:18:31 (post-merge)
- VM verification timestamp: 2026-05-08 13:13–13:16 (all 183 tests green)
