---
created: 2026-05-07T03:00:02+09:00
updated: 2026-05-07T13:40:00+09:00
status: closed
severity: medium
component: transpiler / TAC optimizer
related_branch: feat/readonly-array-folding
fix_branch: fix/transitive-alias-not-tracked-across-iterations
fix_commit: 6daf8d1
---

# Transitive aliases created by copy propagation are not tracked by readonlyArrayFolding

## Summary

`readonlyArrayFolding` tracks only the original constructor temporary and one
direct alias (the first `Assignment`/`Copy` to a named variable). If copy
propagation — which runs later in the same iteration — creates a second-level
alias (`b = scores` where `scores` is the tracked alias), reads through `b`
are never folded, even on subsequent optimizer iterations.

## Example

```
// Iteration 1
t0 = call __ctor_SystemInt32Array(3)
t0[0] = 10; t0[1] = 20; t0[2] = 30
scores = t0
b = scores          // created by copy propagation later in iteration 1
t1 = b[0]           // not folded — b is not tracked

// Iteration 2
// readonlyArrayFolding re-identifies t0 as a candidate, tracks scores as alias
// but b = scores is still a separate copy — b is still not tracked
```

## Why it happens

- `readonlyArrayFolding` runs after SCCP but before copy propagation in the
  pass ordering.
- Copy propagation may create new aliases of the array variable.
- On iteration 2+, `readonlyArrayFolding` re-scans from scratch, but it only
  records one alias per candidate (the first `Assignment`/`Copy` whose `src`
  matches the constructor temporary).

## Impact

Conservative but correct — reads through transitive aliases are left as
runtime array accesses instead of being folded to constants. No miscompilation.
The AST-level `analyzeNativeArrayIneligibility` filter prevents user-level
aliasing from reaching `NativeArrayTypeSymbol`, so this gap only affects
optimizer-internal copies.

## Fix

Fix 1 を適用: `aliasName: string | null` を `aliasNames: Set<string>` に変更し、
post-init フェーズで既知エイリアスからのコピーを検出するたびに Set を成長させる。

### 主な変更点

- `ArrayCandidate.aliasName` → `aliasNames: Set<string>`
- `matchesCandidate` / `findCandidateByTempOrAlias` を Set 参照に更新
- Assignment/Copy の post-init 処理を2段階に分割:
  - **(A) 再代入チェック**: src が同一配列でなければ無効化（`srcIsSameArray` ガード付き）
  - **(B) 推移的エイリアス追加**: src が既知エイリアスなら dest を `aliasNames` に追加
- init フェーズのエイリアス作成時、dest を保持する他候補を無効化して stale な推移エイリアスを防止
- Pass 2 の `aliasToCandidates` 構築を `aliasNames` Set の iterate に変更
- テスト3件追加: 推移エイリアス折りたたみ / 再代入時の無効化リグレッション / 深さ3チェーン

### 適用しなかった代替案

Fix 2 (pass ordering 変更) は readonlyArrayFolding を早期に実行する利点
（同イテレーション内の後続パスが定数を活用できる）を失うため不採用。

## Relevant files

- `src/transpiler/ir/optimizer/passes/readonly_array_folding.ts` — 修正済み
- `tests/unit/transpiler/optimizer_readonly_array.test.ts` — テスト追加済み
