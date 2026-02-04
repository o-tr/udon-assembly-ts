/**
 * VRChat DataContainer type stubs.
 *
 * VRC.SDK3.Data の DataList / DataDictionary をTypeScript側で表現するための
 * コンパイル用スタブ。
 */
import { UdonStub } from "./UdonDecorators.js";

@UdonStub("VRC.SDK3.Data.DataList")
export class DataList {
  // Minimal surface for transpilation/type-checking.
  Count!: number;
  [index: number]: DataToken;

  Add(_value: unknown): void {}
  RemoveAt(_index: number): void {}
  Insert(_index: number, _value: unknown): void {}
  Sort(): void {}
  IndexOf(_value: unknown): number {
    return -1;
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
  Count!: number;
  [key: string]: DataToken | number | ((...args: unknown[]) => unknown);

  ContainsKey(_key: unknown): boolean {
    return false;
  }
  Remove(_key: unknown): boolean {
    return false;
  }
  GetKeys(): DataList {
    return new DataList();
  }
  GetValues(): DataList {
    return new DataList();
  }
}
