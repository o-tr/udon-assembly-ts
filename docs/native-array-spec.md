# ネイティブ配列仕様（udon-assembly-ts）

## 1. 目的

この文書は、Udon VM におけるネイティブ配列 EXTERN の実態と、`udon-assembly-ts` 側の現在の配列 lowering 方針を定義する。

## 2. 用語

- **ネイティブ配列**: `SystemObjectArray`, `SystemInt32Array` などの型付き配列。
- **DataList lowering**: TypeScript の `T[]` を UASM で `VRCSDK3DataDataList` ベースへ変換する現行方針。

## 3. 検証済み事実

Unity の Udon NodeDefinition で以下を確認済み。

- `SystemObjectArray.__ctor__SystemInt32__SystemObjectArray`
- `SystemObjectArray.__Get__SystemInt32__SystemObject`
- `SystemObjectArray.__Set__SystemInt32_SystemObject__SystemVoid`
- `SystemObjectArray.__get_Length__SystemInt32`
- `SystemInt32Array` 系でも同等の `__ctor__/__Get__/__Set__/__get_Length` が存在

また、手書き UASM を `UasmTestRunner` で実行し、`SystemObjectArray` の `ctor + set + get` が成功することを確認済み。

## 4. シグネチャ運用ルール

### 4.1 配列要素アクセス（必須）

配列アクセスは **型付き owner** を使うこと。

- 正: `SystemObjectArray.__Get__SystemInt32__SystemObject`
- 正: `SystemObjectArray.__Set__SystemInt32_SystemObject__SystemVoid`
- 誤: `SystemArray.__Get__...` / `SystemArray.__Set__...`（NodeDefinition になく、実行時例外要因）

### 4.2 配列生成（必須）

- 正: `SystemObjectArray.__ctor__SystemInt32__SystemObjectArray`
- 正: `SystemInt32Array.__ctor__SystemInt32__SystemInt32Array`

### 4.3 長さ取得

`__get_Length__SystemInt32` は型付き配列 owner 側にも存在する。  
`SystemArray.__get_Length__SystemInt32` は静的ヘルパー/基底配列系と混同しないこと。

## 5. 既知の失敗パターン（旧生成物）

以下の混在は危険:

1. `SystemObjectArray.__ctor__...` で配列を生成
2. 直後に `SystemArray.__Set__...` / `SystemArray.__Get__...` を呼ぶ

この場合、owner が一致せず VM 実行時に `UdonVMException` へ繋がる。

## 6. 現在の transpiler 方針

現行 `udon-assembly-ts` は、TypeScript 配列を既定で DataList として lowering する。

- `get_Item` / `set_Item` / `Add` / `Count` を使用
- ネイティブ配列 EXTERN はポリシーとして生成しない（VM 非対応という意味ではない）

## 7. 将来 native-lowering を導入する場合の必須条件

1. ヒープ型を `%SystemArray` ではなく `%SystemObjectArray` / `%SystemInt32Array` など型付きで保持する。  
2. `ctor/get/set/length` の owner を同一型で統一する。  
3. `SystemArray` は `Copy` など基底配列 API 用途に限定する。  
4. `UasmTestRunner` で `ctor + set + get + length` 実行テストを常設する。  

