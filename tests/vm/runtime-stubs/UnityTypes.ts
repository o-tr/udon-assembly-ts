/**
 * Runtime implementations of Unity types for JS runtime tests.
 *
 * Only types actually used by test cases are implemented:
 * Debug, Mathf, Vector3.
 *
 * NOTE: We do NOT re-export from src/stubs/UnityTypes.ts because loading
 * that module triggers Vector3 static field initialization which causes
 * infinite recursion (Vector3.normalized field creates new Vector3 instances).
 */

import { captureLog } from "./capture.js";
import { UdonExtern, UdonStub } from "./UdonDecorators.js";
import type { UdonFloat, UdonInt } from "./UdonTypes.js";

// ---------------------------------------------------------------------------
// Debug — captures log output via captureLog()
// ---------------------------------------------------------------------------

@UdonStub("UnityEngine.Debug")
export class Debug {
  static Log(_message: object): void;
  static Log(_message: string): void;
  static Log(_message: number): void;
  static Log(_message: boolean): void;
  @UdonExtern({
    signature: "UnityEngineDebug.__Log__SystemObject__SystemVoid",
  })
  static Log(_message: unknown): void {
    captureLog(_message);
  }

  static LogWarning(_message: object): void;
  static LogWarning(_message: string): void;
  static LogWarning(_message: number): void;
  static LogWarning(_message: boolean): void;
  @UdonExtern({
    signature: "UnityEngineDebug.__LogWarning__SystemObject__SystemVoid",
  })
  static LogWarning(_message: unknown): void {
    captureLog(_message);
  }

  static LogError(_message: object): void;
  static LogError(_message: string): void;
  static LogError(_message: number): void;
  static LogError(_message: boolean): void;
  @UdonExtern({
    signature: "UnityEngineDebug.__LogError__SystemObject__SystemVoid",
  })
  static LogError(_message: unknown): void {
    captureLog(_message);
  }
}

// ---------------------------------------------------------------------------
// Mathf — single-precision implementations using JS Math + Math.fround()
//
// Unity's Mathf operates on C# float (IEEE 754 single-precision).
// All inputs are fround'd to simulate float parameters, and all float
// outputs are fround'd to match single-precision return values.
// ---------------------------------------------------------------------------

@UdonStub("UnityEngine.Mathf")
export class Mathf {
  static Abs(value: UdonFloat): UdonFloat {
    return Math.fround(Math.abs(Math.fround(value))) as UdonFloat;
  }
  static Ceil(value: UdonFloat): UdonFloat {
    return Math.ceil(Math.fround(value)) as UdonFloat;
  }
  static CeilToInt(value: UdonFloat): UdonInt {
    return Math.ceil(Math.fround(value)) as UdonInt;
  }
  static Clamp(value: UdonFloat, min: UdonFloat, max: UdonFloat): UdonFloat {
    return Math.fround(
      Math.min(Math.max(Math.fround(value), Math.fround(min)), Math.fround(max)),
    ) as UdonFloat;
  }
  static Clamp01(value: UdonFloat): UdonFloat {
    return Math.fround(Math.min(Math.max(Math.fround(value), 0), 1)) as UdonFloat;
  }
  static Floor(value: UdonFloat): UdonFloat {
    return Math.floor(Math.fround(value)) as UdonFloat;
  }
  static FloorToInt(value: UdonFloat): UdonInt {
    return Math.floor(Math.fround(value)) as UdonInt;
  }
  static Lerp(a: UdonFloat, b: UdonFloat, t: UdonFloat): UdonFloat {
    const fa = Math.fround(a);
    const fb = Math.fround(b);
    const clamped = Math.fround(Math.min(Math.max(Math.fround(t), 0), 1));
    // Each intermediate step uses fround to match C# float arithmetic
    return Math.fround(fa + Math.fround(Math.fround(fb - fa) * clamped)) as UdonFloat;
  }
  static Max(a: UdonFloat, b: UdonFloat): UdonFloat {
    return Math.max(Math.fround(a), Math.fround(b)) as UdonFloat;
  }
  static Min(a: UdonFloat, b: UdonFloat): UdonFloat {
    return Math.min(Math.fround(a), Math.fround(b)) as UdonFloat;
  }
  static Pow(a: UdonFloat, b: UdonFloat): UdonFloat {
    return Math.fround(Math.pow(Math.fround(a), Math.fround(b))) as UdonFloat;
  }
  static Round(value: UdonFloat): UdonFloat {
    // Unity Mathf.Round uses MidpointRounding.AwayFromZero
    // For negative midpoints: C# rounds away from zero, JS rounds toward +Infinity
    const fv = Math.fround(value);
    if (fv > 0) {
      return Math.floor(Math.fround(fv + 0.5)) as UdonFloat;
    }
    return Math.ceil(Math.fround(fv - 0.5)) as UdonFloat;
  }
  static RoundToInt(value: UdonFloat): UdonInt {
    return Mathf.Round(value) as unknown as UdonInt;
  }
  static Sqrt(value: UdonFloat): UdonFloat {
    return Math.fround(Math.sqrt(Math.fround(value))) as UdonFloat;
  }
  static Sin(value: UdonFloat): UdonFloat {
    return Math.fround(Math.sin(Math.fround(value))) as UdonFloat;
  }
  static Cos(value: UdonFloat): UdonFloat {
    return Math.fround(Math.cos(Math.fround(value))) as UdonFloat;
  }
  static Tan(value: UdonFloat): UdonFloat {
    return Math.fround(Math.tan(Math.fround(value))) as UdonFloat;
  }
  static Atan2(y: UdonFloat, x: UdonFloat): UdonFloat {
    return Math.fround(Math.atan2(Math.fround(y), Math.fround(x))) as UdonFloat;
  }
  static Log(value: UdonFloat): UdonFloat {
    return Math.fround(Math.log(Math.fround(value))) as UdonFloat;
  }
  static Log10(value: UdonFloat): UdonFloat {
    return Math.fround(Math.log10(Math.fround(value))) as UdonFloat;
  }
  static Sign(value: UdonFloat): UdonFloat {
    return Math.fround(Math.sign(Math.fround(value))) as UdonFloat;
  }

  static readonly PI: UdonFloat = Math.fround(Math.PI) as UdonFloat;
  static readonly Infinity: UdonFloat = Number.POSITIVE_INFINITY as UdonFloat;
  static readonly NegativeInfinity: UdonFloat =
    Number.NEGATIVE_INFINITY as UdonFloat;
  static readonly Deg2Rad: UdonFloat = Math.fround(Math.PI / 180) as UdonFloat;
  static readonly Rad2Deg: UdonFloat = Math.fround(180 / Math.PI) as UdonFloat;
  static readonly Epsilon: UdonFloat = 1.1920929e-7 as UdonFloat;
}

// ---------------------------------------------------------------------------
// Vector3 — real implementation with formatted toString()
// ---------------------------------------------------------------------------

@UdonStub("UnityEngine.Vector3")
export class Vector3 {
  x: UdonFloat;
  y: UdonFloat;
  z: UdonFloat;

  get magnitude(): UdonFloat {
    return Math.sqrt(
      this.x * this.x + this.y * this.y + this.z * this.z,
    ) as UdonFloat;
  }

  get normalized(): Vector3 {
    const mag = this.magnitude;
    if (mag === 0) return new Vector3(0, 0, 0);
    return new Vector3(this.x / mag, this.y / mag, this.z / mag);
  }

  constructor(
    x: UdonFloat | number,
    y: UdonFloat | number,
    z: UdonFloat | number,
  ) {
    this.x = x as UdonFloat;
    this.y = y as UdonFloat;
    this.z = z as UdonFloat;
  }

  toString(): string {
    // Match Unity's Vector3.ToString() format: "(x.xx, y.yy, z.zz)"
    return `(${this.x.toFixed(2)}, ${this.y.toFixed(2)}, ${this.z.toFixed(2)})`;
  }

  static zero: Vector3 = Object.freeze(new Vector3(0, 0, 0)) as Vector3;
  static one: Vector3 = Object.freeze(new Vector3(1, 1, 1)) as Vector3;
  static up: Vector3 = Object.freeze(new Vector3(0, 1, 0)) as Vector3;
  static forward: Vector3 = Object.freeze(new Vector3(0, 0, 1)) as Vector3;
  static right: Vector3 = Object.freeze(new Vector3(1, 0, 0)) as Vector3;
  static down: Vector3 = Object.freeze(new Vector3(0, -1, 0)) as Vector3;
  static back: Vector3 = Object.freeze(new Vector3(0, 0, -1)) as Vector3;
  static left: Vector3 = Object.freeze(new Vector3(-1, 0, 0)) as Vector3;

  static Distance(a: Vector3, b: Vector3): UdonFloat {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) as UdonFloat;
  }

  static Dot(a: Vector3, b: Vector3): UdonFloat {
    return (a.x * b.x + a.y * b.y + a.z * b.z) as UdonFloat;
  }

  static Cross(a: Vector3, b: Vector3): Vector3 {
    return new Vector3(
      a.y * b.z - a.z * b.y,
      a.z * b.x - a.x * b.z,
      a.x * b.y - a.y * b.x,
    );
  }

  static Lerp(a: Vector3, b: Vector3, t: UdonFloat | number): Vector3 {
    const clamped = Math.min(Math.max(t as number, 0), 1);
    return new Vector3(
      a.x + (b.x - a.x) * clamped,
      a.y + (b.y - a.y) * clamped,
      a.z + (b.z - a.z) * clamped,
    );
  }

  static Angle(from: Vector3, to: Vector3): UdonFloat {
    const dot = Vector3.Dot(from.normalized, to.normalized);
    const clamped = Math.min(Math.max(dot, -1), 1);
    return (Math.acos(clamped) * (180 / Math.PI)) as UdonFloat;
  }
}
