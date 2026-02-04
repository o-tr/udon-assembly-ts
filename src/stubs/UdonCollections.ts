/**
 * UdonSharp collection stubs.
 */

import { UdonStub } from "./UdonDecorators.js";
import { SystemCollectionsIEnumerator } from "./SystemTypes.js";
import type { UdonInt } from "./UdonTypes.js";

@UdonStub("UdonSharpRuntime_List")
export class UdonList<T> {
  Count: UdonInt = 0 as UdonInt;

  Add(_value: T): void {}
  Remove(_value: T): boolean {
    return false;
  }
  RemoveAt(_index: UdonInt): void {}
  RemoveRange(_index: UdonInt, _count: UdonInt): void {}
  Clear(): void {}
  Contains(_value: T): boolean {
    return false;
  }
  IndexOf(_value: T): UdonInt {
    return 0 as UdonInt;
  }
  Insert(_index: UdonInt, _value: T): void {}
  Sort(): void {}
  Reverse(): void {}
  ToArray(): T[] {
    return [];
  }
  get_Item(_index: UdonInt): T {
    return null as unknown as T;
  }
  set_Item(_index: UdonInt, _value: T): void {}
  GetEnumerator(): SystemCollectionsIEnumerator {
    return new SystemCollectionsIEnumerator();
  }

  static CreateFromArray<TItem>(_array: TItem[]): UdonList<TItem> {
    return new UdonList<TItem>();
  }

  static CreateFromHashSet<TItem>(
    _set: UdonHashSet<TItem>,
  ): UdonList<TItem> {
    return new UdonList<TItem>();
  }
}

@UdonStub("UdonSharpRuntime_Dictionary")
export class UdonDictionary<TKey, TValue> {
  Count: UdonInt = 0 as UdonInt;

  Add(_key: TKey, _value: TValue): void {}
  Remove(_key: TKey): boolean {
    return false;
  }
  ContainsKey(_key: TKey): boolean {
    return false;
  }
  ContainsValue(_value: TValue): boolean {
    return false;
  }
  TryGetValue(_key: TKey, _value: TValue): boolean {
    return false;
  }
  Clear(): void {}
  get_Item(_key: TKey): TValue {
    return null as unknown as TValue;
  }
  set_Item(_key: TKey, _value: TValue): void {}
  GetEnumerator(): UdonSharpRuntime_DictionaryIterator {
    return new UdonSharpRuntime_DictionaryIterator();
  }
}

@UdonStub("UdonSharpRuntime_Queue")
export class UdonQueue<T> {
  Count: UdonInt = 0 as UdonInt;

  Enqueue(_value: T): void {}
  Dequeue(): T {
    return null as unknown as T;
  }
  TryDequeue(_value: T): boolean {
    return false;
  }
  TryPeek(_value: T): boolean {
    return false;
  }
  Peek(): T {
    return null as unknown as T;
  }
  ToArray(): T[] {
    return [];
  }
  Contains(_value: T): boolean {
    return false;
  }
  GetEnumerator(): UdonSharpRuntime_QueueIterator {
    return new UdonSharpRuntime_QueueIterator();
  }
  Clear(): void {}
}

@UdonStub("UdonSharpRuntime_Stack")
export class UdonStack<T> {
  Count: UdonInt = 0 as UdonInt;

  Push(_value: T): void {}
  Pop(): T {
    return null as unknown as T;
  }
  Peek(): T {
    return null as unknown as T;
  }
  TryPeek(_value: T): boolean {
    return false;
  }
  TryPop(_value: T): boolean {
    return false;
  }
  ToArray(): T[] {
    return [];
  }
  TrimExcess(): void {}
  Contains(_value: T): boolean {
    return false;
  }
  GetEnumerator(): UdonSharpRuntime_StackIterator {
    return new UdonSharpRuntime_StackIterator();
  }
  Clear(): void {}
}

@UdonStub("UdonSharpRuntime_HashSet")
export class UdonHashSet<T> {
  Count: UdonInt = 0 as UdonInt;

  Add(_value: T): boolean {
    return false;
  }
  Remove(_value: T): boolean {
    return false;
  }
  Contains(_value: T): boolean {
    return false;
  }
  Clear(): void {}
  UnionWith(_other: UdonHashSet<T>): void {}
  IntersectWith(_other: UdonHashSet<T>): void {}
  ExceptWith(_other: UdonHashSet<T>): void {}
  SymmetricExceptWith(_other: UdonHashSet<T>): void {}
  IsSubsetOf(_other: UdonHashSet<T>): boolean {
    return false;
  }
  IsSupersetOf(_other: UdonHashSet<T>): boolean {
    return false;
  }
  IsProperSubsetOf(_other: UdonHashSet<T>): boolean {
    return false;
  }
  IsProperSupersetOf(_other: UdonHashSet<T>): boolean {
    return false;
  }
  Overlaps(_other: UdonHashSet<T>): boolean {
    return false;
  }
  SetEquals(_other: UdonHashSet<T>): boolean {
    return false;
  }
  ToArray(): T[] {
    return [];
  }
  GetEnumerator(): UdonSharpRuntime_HashSetIterator {
    return new UdonSharpRuntime_HashSetIterator();
  }

  static CreateFromArray<TItem>(_array: TItem[]): UdonHashSet<TItem> {
    return new UdonHashSet<TItem>();
  }

  static CreateFromList<TItem>(_list: UdonList<TItem>): UdonHashSet<TItem> {
    return new UdonHashSet<TItem>();
  }
}

@UdonStub("UdonSharpRuntime_DictionaryIterator")
export class UdonSharpRuntime_DictionaryIterator {}

@UdonStub("UdonSharpRuntime_QueueIterator")
export class UdonSharpRuntime_QueueIterator {}

@UdonStub("UdonSharpRuntime_StackIterator")
export class UdonSharpRuntime_StackIterator {}

@UdonStub("UdonSharpRuntime_HashSetIterator")
export class UdonSharpRuntime_HashSetIterator {}
