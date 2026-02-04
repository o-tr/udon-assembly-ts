/**
 * VRChat DataContainer type stubs.
 *
 * VRC.SDK3.Data の DataList / DataDictionary をTypeScript側で表現するための
 * コンパイル用スタブ。
 */
import { UdonStub } from "./UdonDecorators.js";
import type { UdonInt } from "./UdonTypes.js";

@UdonStub("VRC.SDK3.Data.DataList")
export class DataList {
  // Minimal surface for transpilation/type-checking.
  constructor() {}

  Count!: UdonInt;
  [index: number]: DataToken;

  Add(_value: DataToken): void {}
  get_Item(_index: UdonInt): DataToken {
    return new DataToken();
  }
  set_Item(_index: UdonInt, _value: DataToken): void {}
  Remove(_value: DataToken): boolean {
    return false;
  }
  RemoveAt(_index: UdonInt): void {}
  Insert(_index: UdonInt, _value: DataToken): void {}
  Sort(): void {}
  IndexOf(_value: DataToken): UdonInt {
    return 0 as UdonInt;
  }
  TryGetValue(_index: UdonInt, _value: DataToken): boolean {
    return false;
  }
  // Allow `for..of` in TypeScript sources.
  [Symbol.iterator](): Iterator<DataToken> {
    return {
      next: () => ({ done: true, value: new DataToken() }),
    };
  }
}

@UdonStub("VRC.SDK3.Data.DataToken")
export class DataToken {
  String!: string;
  Boolean!: boolean;
  Int!: number;
  Long!: number;
  Float!: number;
  Double!: number;
  DataList!: DataList;
  DataDictionary!: DataDictionary;
  Reference!: object;
  IsNull!: boolean;
  TokenType!: number;

  constructor();
  constructor(_value: number);
  constructor(_value: string);
  constructor(_value: boolean);
  constructor(_value: DataList);
  constructor(_value: DataDictionary);
  constructor(_value: object);
  // biome-ignore lint/complexity/noUselessConstructor: value-accepting stub constructor for transpiled `new DataToken(x)`
  constructor(_value?: unknown) {}
}

/**
 * DataDictionary スタブ（DataContainer基盤）
 *
 * TypeScript側で `extends DataDictionary` を表現するための型定義。
 */
@UdonStub("VRC.SDK3.Data.DataDictionary")
export class DataDictionary {
  constructor() {}

  Count!: UdonInt;
  [key: string]: any;

  SetValue(_key: DataToken, _value: DataToken): void {}
  GetValue(_key: DataToken): DataToken {
    return new DataToken();
  }
  TryGetValue(_key: DataToken, _value: DataToken): boolean {
    return false;
  }
  ContainsKey(_key: DataToken): boolean {
    return false;
  }
  Remove(_key: DataToken): boolean {
    return false;
  }
  GetKeys(): DataList {
    return new DataList();
  }
  GetValues(): DataList {
    return new DataList();
  }
}
