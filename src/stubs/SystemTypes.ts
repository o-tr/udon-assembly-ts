/**
 * System namespace stubs (C# core types).
 */

import { UdonExtern, UdonStub } from "./UdonDecorators.js";
import type { UdonDouble, UdonInt } from "./UdonTypes.js";

@UdonStub("System.String")
export class String {
  @UdonExtern("Length")
  length: UdonInt = 0 as UdonInt;

  static Concat(_a: string, _b: string): string {
    return "";
  }

  Contains(_value: string): boolean {
    return false;
  }
  StartsWith(_value: string): boolean {
    return false;
  }
  EndsWith(_value: string): boolean {
    return false;
  }
  IndexOf(_value: string): UdonInt {
    return 0 as UdonInt;
  }

  Substring(_startIndex: UdonInt): string;
  Substring(_startIndex: UdonInt, _length: UdonInt): string;
  Substring(_startIndex: UdonInt, _length?: UdonInt): string {
    return "";
  }

  ToLower(): string {
    return "";
  }
  ToUpper(): string {
    return "";
  }
  Trim(): string {
    return "";
  }
}

@UdonStub("System.Int32")
export class Int32 {
  static Parse(_value: string): UdonInt {
    return 0 as UdonInt;
  }
}

@UdonStub("System.Array")
export class SystemArray {
  static Get(_index: UdonInt): object {
    return null as unknown as object;
  }

  static Set(_index: UdonInt, _value: object): void {}
}

@UdonStub("System.Convert")
export class Convert {}

@UdonStub("System.Math")
export class Math {
  static Truncate(_value: UdonDouble | number): UdonDouble {
    return 0 as UdonDouble;
  }
}

@UdonStub("System.Type")
export class Type {
  static GetType(_name: string): Type {
    return null as unknown as Type;
  }
}

@UdonStub("System.Collections.IEnumerator")
export class SystemCollectionsIEnumerator {}
