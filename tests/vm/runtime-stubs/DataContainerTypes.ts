/**
 * Runtime implementations of VRC DataContainer types for JS runtime tests.
 */
import { UdonExtern, UdonStub } from "./UdonDecorators.js";
import type { UdonInt, UdonLong } from "./UdonTypes.js";

// DataToken type enum (matches VRC SDK)
const TokenType = {
  Null: 0,
  Boolean: 1,
  SByte: 2,
  Byte: 3,
  Short: 4,
  UShort: 5,
  Int: 6,
  UInt: 7,
  Long: 8,
  ULong: 9,
  Float: 10,
  Double: 11,
  String: 12,
  DataList: 13,
  DataDictionary: 14,
  Reference: 15,
} as const;

@UdonStub("VRC.SDK3.Data.DataToken")
export class DataToken {
  private _value: unknown;
  private _tokenType: number;

  get String(): string {
    return String(this._value ?? "");
  }
  get Boolean(): boolean {
    return Boolean(this._value);
  }
  get Int(): UdonInt {
    return (Number(this._value) | 0) as UdonInt;
  }
  get Long(): UdonLong {
    return BigInt(Math.trunc(Number(this._value))) as UdonLong;
  }
  get Float(): number {
    return Number(this._value);
  }
  get Double(): number {
    return Number(this._value);
  }
  get DataList(): DataList {
    return this._value as DataList;
  }
  get DataDictionary(): DataDictionary {
    return this._value as DataDictionary;
  }
  get Reference(): object {
    return this._value as object;
  }
  get IsNull(): boolean {
    return this._value === null || this._value === undefined;
  }
  get TokenType(): number {
    return this._tokenType;
  }

  constructor();
  constructor(_value: number);
  constructor(_value: UdonInt);
  constructor(_value: string);
  constructor(_value: boolean);
  constructor(_value: DataList);
  constructor(_value: DataDictionary);
  constructor(_value: object);
  constructor(_value?: unknown) {
    this._value = _value ?? null;
    if (_value === null || _value === undefined) {
      this._tokenType = TokenType.Null;
    } else if (typeof _value === "boolean") {
      this._tokenType = TokenType.Boolean;
    } else if (typeof _value === "number") {
      // Heuristic: whole numbers in the Int32 range → TokenType.Int.
      // LIMITATION: TypeScript branded types (UdonInt vs UdonFloat) are
      // erased at runtime, so `new DataToken(42 as UdonFloat)` is
      // indistinguishable from `new DataToken(42 as UdonInt)` here and
      // will receive TokenType.Int, diverging from the Udon VM which
      // assigns TokenType.Float. Use DataToken.fromFloat(v) explicitly
      // when you need a Float token for a whole-number value.
      this._tokenType =
        Number.isInteger(_value) &&
        _value >= -2147483648 &&
        _value <= 2147483647
          ? TokenType.Int
          : TokenType.Float;
    } else if (typeof _value === "string") {
      this._tokenType = TokenType.String;
    } else if (_value instanceof DataList) {
      this._tokenType = TokenType.DataList;
    } else if (_value instanceof DataDictionary) {
      this._tokenType = TokenType.DataDictionary;
    } else {
      this._tokenType = TokenType.Reference;
    }
  }

  /** Internal: get the raw stored value for equality comparison */
  _getRawValue(): unknown {
    return this._value;
  }

  /** Internal: copy another token's value into this one */
  _copyFrom(other: DataToken): void {
    this._value = other._value;
    this._tokenType = other._tokenType;
  }

  /**
   * Create a DataToken that is always typed as Float, even for whole numbers.
   * Use this when the Udon VM would store the value as a float token
   * (e.g., a UdonFloat that happens to be a whole number like 42.0).
   */
  static fromFloat(v: number): DataToken {
    const token = new DataToken(v);
    token._tokenType = TokenType.Float;
    return token;
  }

  /** Value equality for Remove/IndexOf operations */
  _equals(other: DataToken): boolean {
    if (this._tokenType !== other._tokenType) return false;
    return this._value === other._value;
  }
}

class DataListImpl {
  _items: DataToken[] = [];

  get Count(): UdonInt {
    return this._items.length as UdonInt;
  }

  Add(value: DataToken): void {
    this._items.push(value);
  }

  get_Item(index: UdonInt): DataToken {
    return this._items[index as number];
  }

  set_Item(index: UdonInt, value: DataToken): void {
    this._items[index as number] = value;
  }

  Remove(value: DataToken): boolean {
    const idx = this._items.findIndex((item) => item._equals(value));
    if (idx === -1) return false;
    this._items.splice(idx, 1);
    return true;
  }

  RemoveAt(index: UdonInt): void {
    this._items.splice(index as number, 1);
  }

  Insert(index: UdonInt, value: DataToken): void {
    this._items.splice(index as number, 0, value);
  }

  Sort(): void {
    const collator = new Intl.Collator("en-US", { sensitivity: "variant" });
    this._items.sort((a, b) => {
      const av = a._getRawValue();
      const bv = b._getRawValue();
      if (typeof av === "number" && typeof bv === "number") return av - bv;
      return collator.compare(String(av), String(bv));
    });
  }

  IndexOf(value: DataToken): UdonInt {
    const idx = this._items.findIndex((item) => item._equals(value));
    return idx as UdonInt;
  }

  TryGetValue(index: UdonInt, outToken: DataToken): boolean {
    const i = index as number;
    if (i >= 0 && i < this._items.length) {
      outToken._copyFrom(this._items[i]);
      return true;
    }
    return false;
  }

  [Symbol.iterator](): Iterator<DataToken> {
    let idx = 0;
    const items = this._items;
    return {
      next(): IteratorResult<DataToken> {
        if (idx < items.length) {
          return { done: false, value: items[idx++] };
        }
        return { done: true, value: undefined as unknown as DataToken };
      },
    };
  }
}

/**
 * Proxy-based DataList that supports bracket notation (list[0]).
 *
 * Returns a Proxy from the constructor to intercept numeric property access,
 * emulating C# list-style indexing (e.g., `list[0]`) via get/set handlers
 * on `_items`. This is required because test case source files use
 * `new DataList()` with bracket notation.
 */
@UdonStub("VRC.SDK3.Data.DataList")
export class DataList extends DataListImpl {
  [index: number]: DataToken;

  constructor() {
    super();
    // biome-ignore lint/correctness/noConstructorReturn: Proxy wrapping is required for list-style indexing
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          return target._items[Number(prop)];
        }
        return Reflect.get(target, prop, receiver);
      },
      set(target, prop, value, receiver) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          // Ensure stored values are always DataToken instances so that
          // Remove / Sort / TryGetValue never see raw primitives.
          target._items[Number(prop)] =
            value instanceof DataToken ? value : new DataToken(value);
          return true;
        }
        return Reflect.set(target, prop, value, receiver);
      },
    });
  }
}

@UdonStub("VRC.SDK3.Data.DataDictionary")
export class DataDictionary {
  // Use parallel arrays to preserve insertion order and support DataToken keys
  // @ts-expect-error: private fields conflict with index signature
  private _keys: DataToken[] = [];
  // @ts-expect-error: private fields conflict with index signature
  private _values: DataToken[] = [];

  get Count(): UdonInt {
    return this._keys.length as UdonInt;
  }

  // Allow index signature for compatibility
  [key: string]:
    | DataToken
    | DataList
    | number
    | boolean
    | ((...args: DataToken[]) => DataToken | DataList | boolean | undefined)
    | ((...args: DataToken[]) => void);

  private _findKeyIndex(key: DataToken): number {
    return this._keys.findIndex((k) => k._equals(key));
  }

  SetValue(key: DataToken, value: DataToken): void {
    const idx = this._findKeyIndex(key);
    if (idx !== -1) {
      this._values[idx] = value;
    } else {
      this._keys.push(key);
      this._values.push(value);
    }
  }

  @UdonExtern({ name: "get_Item" })
  GetValue(key: DataToken): DataToken {
    const idx = this._findKeyIndex(key);
    if (idx === -1) return new DataToken();
    return this._values[idx];
  }

  TryGetValue(key: DataToken, outToken: DataToken): boolean {
    const idx = this._findKeyIndex(key);
    if (idx !== -1) {
      outToken._copyFrom(this._values[idx]);
      return true;
    }
    return false;
  }

  ContainsKey(key: DataToken): boolean {
    return this._findKeyIndex(key) !== -1;
  }

  Remove(key: DataToken): boolean {
    const idx = this._findKeyIndex(key);
    if (idx === -1) return false;
    this._keys.splice(idx, 1);
    this._values.splice(idx, 1);
    return true;
  }

  Clear(): void {
    this._keys.length = 0;
    this._values.length = 0;
  }

  GetKeys(): DataList {
    const list = new DataList();
    for (const key of this._keys) {
      list.Add(key);
    }
    return list;
  }

  GetValues(): DataList {
    const list = new DataList();
    for (const val of this._values) {
      list.Add(val);
    }
    return list;
  }

  ShallowClone(): DataDictionary {
    const clone = new DataDictionary();
    for (let i = 0; i < this._keys.length; i++) {
      // C# DataToken is a struct — copy each token into a new wrapper
      // so the clone's entries are independent of the original's.
      const clonedKey = new DataToken();
      clonedKey._copyFrom(this._keys[i]);
      const clonedValue = new DataToken();
      clonedValue._copyFrom(this._values[i]);
      clone._keys.push(clonedKey);
      clone._values.push(clonedValue);
    }
    return clone;
  }

  [Symbol.iterator](): Iterator<[DataToken, DataToken]> {
    let idx = 0;
    const keys = this._keys;
    const values = this._values;
    return {
      next(): IteratorResult<[DataToken, DataToken]> {
        if (idx < keys.length) {
          const pair: [DataToken, DataToken] = [keys[idx], values[idx]];
          idx++;
          return { done: false, value: pair };
        }
        return {
          done: true,
          value: undefined as unknown as [DataToken, DataToken],
        };
      },
    };
  }
}
