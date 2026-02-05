/**
 * System namespace stubs (C# core types).
 */

import { UdonExtern, UdonStub } from "./UdonDecorators.js";
import type {
  UdonByte,
  UdonDouble,
  UdonFloat,
  UdonInt,
  UdonLong,
  UdonULong,
} from "./UdonTypes.js";

@UdonStub("System.String")
export class SystemString {
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

@UdonStub("System.Text.StringBuilder")
export class StringBuilder {
  Append(_value: SystemString): StringBuilder;
  Append(_value: string): StringBuilder;
  Append(_value: number): StringBuilder;
  Append(_value: UdonInt): StringBuilder;
  Append(_value: UdonFloat): StringBuilder;
  Append(_value: UdonDouble): StringBuilder;
  Append(_value: boolean): StringBuilder;
  Append(
    _value: SystemString | string | number | UdonInt | UdonFloat | UdonDouble | boolean,
  ): StringBuilder {
    return this;
  }

  ToString(): string {
    return "";
  }

  @UdonExtern("Length")
  length: UdonInt = 0 as UdonInt;

  Clear(): StringBuilder {
    return this;
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
export class Convert {
  static ToInt32(_value: UdonByte): UdonInt;
  static ToInt32(_value: UdonInt): UdonInt;
  static ToInt32(_value: UdonFloat): UdonInt;
  static ToInt32(_value: UdonDouble): UdonInt;
  static ToInt32(_value: UdonLong): UdonInt;
  static ToInt32(_value: UdonULong): UdonInt;
  static ToInt32(
    _value: UdonByte | UdonInt | UdonFloat | UdonDouble | UdonLong | UdonULong,
  ): UdonInt {
    return 0 as UdonInt;
  }

  static ToInt64(_value: UdonByte): UdonLong;
  static ToInt64(_value: UdonInt): UdonLong;
  static ToInt64(_value: UdonFloat): UdonLong;
  static ToInt64(_value: UdonDouble): UdonLong;
  static ToInt64(_value: UdonLong): UdonLong;
  static ToInt64(_value: UdonULong): UdonLong;
  static ToInt64(
    _value: UdonByte | UdonInt | UdonFloat | UdonDouble | UdonLong | UdonULong,
  ): UdonLong {
    return 0n as UdonLong;
  }

  static ToUInt64(_value: UdonByte): UdonULong;
  static ToUInt64(_value: UdonInt): UdonULong;
  static ToUInt64(_value: UdonFloat): UdonULong;
  static ToUInt64(_value: UdonDouble): UdonULong;
  static ToUInt64(_value: UdonLong): UdonULong;
  static ToUInt64(_value: UdonULong): UdonULong;
  static ToUInt64(
    _value: UdonByte | UdonInt | UdonFloat | UdonDouble | UdonLong | UdonULong,
  ): UdonULong {
    return 0n as UdonULong;
  }

  static ToSingle(_value: UdonByte): UdonFloat;
  static ToSingle(_value: UdonInt): UdonFloat;
  static ToSingle(_value: UdonFloat): UdonFloat;
  static ToSingle(_value: UdonDouble): UdonFloat;
  static ToSingle(_value: UdonLong): UdonFloat;
  static ToSingle(_value: UdonULong): UdonFloat;
  static ToSingle(
    _value: UdonByte | UdonInt | UdonFloat | UdonDouble | UdonLong | UdonULong,
  ): UdonFloat {
    return 0 as UdonFloat;
  }

  static ToDouble(_value: UdonByte): UdonDouble;
  static ToDouble(_value: UdonInt): UdonDouble;
  static ToDouble(_value: UdonFloat): UdonDouble;
  static ToDouble(_value: UdonDouble): UdonDouble;
  static ToDouble(_value: UdonLong): UdonDouble;
  static ToDouble(_value: UdonULong): UdonDouble;
  static ToDouble(
    _value: UdonByte | UdonInt | UdonFloat | UdonDouble | UdonLong | UdonULong,
  ): UdonDouble {
    return 0 as UdonDouble;
  }

  static ToBoolean(_value: UdonByte): boolean;
  static ToBoolean(_value: UdonInt): boolean;
  static ToBoolean(_value: UdonFloat): boolean;
  static ToBoolean(_value: UdonDouble): boolean;
  static ToBoolean(_value: UdonLong): boolean;
  static ToBoolean(_value: UdonULong): boolean;
  static ToBoolean(
    _value: UdonByte | UdonInt | UdonFloat | UdonDouble | UdonLong | UdonULong,
  ): boolean {
    return false;
  }
}

@UdonStub("System.Math")
export class SystemMath {
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

export { SystemString as String, SystemMath as Math };
