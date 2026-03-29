/**
 * Runtime implementations of System namespace types for JS runtime tests.
 *
 * Only types actually used by test cases are implemented: Convert, Type.
 * All other types are re-exported from the original stubs.
 */

import { UdonStub } from "./UdonDecorators.js";
import type {
  UdonByte,
  UdonDouble,
  UdonFloat,
  UdonInt,
  UdonLong,
  UdonULong,
} from "./UdonTypes.js";

// Re-export types not overridden
export {
  Int32,
  String,
  StringBuilder,
  SystemArray,
  SystemCollectionsIEnumerator,
  SystemString,
} from "../../../src/stubs/SystemTypes.js";

// ---------------------------------------------------------------------------
// Convert — real implementations
// ---------------------------------------------------------------------------

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
    // C# Convert.ToInt32 uses banker's rounding (MidpointRounding.ToEven)
    const v = Number(_value);
    return bankerRound(v) as UdonInt;
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
    if (typeof _value === "bigint") return _value as UdonLong;
    return BigInt(bankerRound(Number(_value))) as UdonLong;
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
    if (typeof _value === "bigint") {
      return (_value < 0n ? 0n : _value) as UdonULong;
    }
    const v = Math.max(0, bankerRound(Number(_value)));
    return BigInt(v) as UdonULong;
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
    return Math.fround(Number(_value)) as UdonFloat;
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
    return Number(_value) as UdonDouble;
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
    if (typeof _value === "bigint") return _value !== 0n;
    return Number(_value) !== 0;
  }
}

// ---------------------------------------------------------------------------
// SystemMath — real implementations
// ---------------------------------------------------------------------------

@UdonStub("System.Math")
export class SystemMath {
  static Truncate(_value: UdonDouble | number): UdonDouble {
    return Math.trunc(Number(_value)) as UdonDouble;
  }
}

// ---------------------------------------------------------------------------
// Type — minimal implementation for typeof comparison
// ---------------------------------------------------------------------------

@UdonStub("System.Type")
export class Type {
  private _name: string;

  private constructor(name: string) {
    this._name = name;
  }

  static GetType(name: string): Type {
    return new Type(name);
  }

  toString(): string {
    return this._name;
  }
}

export { SystemMath as Math };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * C# banker's rounding (MidpointRounding.ToEven).
 * Rounds to nearest; if exactly .5, rounds to nearest even number.
 */
function bankerRound(v: number): number {
  const floor = Math.floor(v);
  const frac = v - floor;
  // Not at midpoint: use normal rounding
  if (Math.abs(frac - 0.5) > 1e-10) {
    return Math.round(v);
  }
  // At midpoint: round to even
  return floor % 2 === 0 ? floor : floor + 1;
}
