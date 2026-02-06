export const bankersRound = (value: number): number => {
  const integer = Math.floor(value);
  const frac = value - integer;
  if (Math.abs(frac) === 0.5) {
    return integer % 2 === 0 ? integer : Math.ceil(value);
  }
  if (frac > 0.5) return integer + 1;
  return integer;
};

export type Vector3Value = { x: number; y: number; z: number };
export type PureExternValue = number | string | Vector3Value;
export type PureExternResult = number | string;

const isVector3Value = (value: PureExternValue): value is Vector3Value => {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return false;
  return (
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    typeof value.z === "number"
  );
};

const toNumber = (value: PureExternValue): number | null => {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const toStringValue = (value: PureExternValue): string | null => {
  return typeof value === "string" ? value : null;
};

export const pureExternEvaluators = new Map<
  string,
  { arity: number; eval: (args: PureExternValue[]) => PureExternResult | null }
>([
  [
    "SystemString.__Concat__SystemString_SystemString__SystemString",
    {
      arity: 2,
      eval: ([a, b]) => {
        const left = toStringValue(a);
        const right = toStringValue(b);
        if (left === null || right === null) return null;
        return left + right;
      },
    },
  ],
  [
    "UnityEngineMathf.__Abs__SystemSingle__SystemSingle",
    {
      arity: 1,
      eval: ([a]) => {
        const value = toNumber(a);
        return value !== null ? Math.abs(value) : null;
      },
    },
  ],
  [
    "UnityEngineMathf.__Ceil__SystemSingle__SystemSingle",
    {
      arity: 1,
      eval: ([a]) => {
        const value = toNumber(a);
        return value !== null ? Math.ceil(value) : null;
      },
    },
  ],
  [
    "UnityEngineMathf.__CeilToInt__SystemSingle__SystemInt32",
    {
      arity: 1,
      eval: ([a]) => {
        const value = toNumber(a);
        return value !== null ? Math.ceil(value) : null;
      },
    },
  ],
  [
    "UnityEngineMathf.__Clamp__SystemSingle_SystemSingle_SystemSingle__SystemSingle",
    {
      arity: 3,
      eval: ([v, min, max]) => {
        const vNum = toNumber(v);
        const minNum = toNumber(min);
        const maxNum = toNumber(max);
        if (vNum === null || minNum === null || maxNum === null) return null;
        return Math.min(Math.max(vNum, minNum), maxNum);
      },
    },
  ],
  [
    "UnityEngineMathf.__Clamp01__SystemSingle__SystemSingle",
    {
      arity: 1,
      eval: ([v]) => {
        const vNum = toNumber(v);
        if (vNum === null) return null;
        return Math.min(Math.max(vNum, 0), 1);
      },
    },
  ],
  [
    "UnityEngineMathf.__Floor__SystemSingle__SystemSingle",
    {
      arity: 1,
      eval: ([a]) => {
        const value = toNumber(a);
        return value !== null ? Math.floor(value) : null;
      },
    },
  ],
  [
    "UnityEngineMathf.__FloorToInt__SystemSingle__SystemInt32",
    {
      arity: 1,
      eval: ([a]) => {
        const value = toNumber(a);
        return value !== null ? Math.floor(value) : null;
      },
    },
  ],
  [
    "UnityEngineMathf.__Lerp__SystemSingle_SystemSingle_SystemSingle__SystemSingle",
    {
      arity: 3,
      eval: ([a, b, t]) => {
        const aNum = toNumber(a);
        const bNum = toNumber(b);
        const tNum = toNumber(t);
        if (aNum === null || bNum === null || tNum === null) return null;
        const clamped = Math.min(Math.max(tNum, 0), 1);
        return aNum + (bNum - aNum) * clamped;
      },
    },
  ],
  [
    "UnityEngineMathf.__Max__SystemSingle_SystemSingle__SystemSingle",
    {
      arity: 2,
      eval: ([a, b]) => {
        const aNum = toNumber(a);
        const bNum = toNumber(b);
        if (aNum === null || bNum === null) return null;
        return Math.max(aNum, bNum);
      },
    },
  ],
  [
    "UnityEngineMathf.__Min__SystemSingle_SystemSingle__SystemSingle",
    {
      arity: 2,
      eval: ([a, b]) => {
        const aNum = toNumber(a);
        const bNum = toNumber(b);
        if (aNum === null || bNum === null) return null;
        return Math.min(aNum, bNum);
      },
    },
  ],
  [
    "UnityEngineMathf.__Pow__SystemSingle_SystemSingle__SystemSingle",
    {
      arity: 2,
      eval: ([a, b]) => {
        const aNum = toNumber(a);
        const bNum = toNumber(b);
        if (aNum === null || bNum === null) return null;
        return aNum ** bNum;
      },
    },
  ],
  [
    "UnityEngineMathf.__Round__SystemSingle__SystemSingle",
    {
      arity: 1,
      eval: ([a]) => {
        const value = toNumber(a);
        return value !== null ? bankersRound(value) : null;
      },
    },
  ],
  [
    "UnityEngineMathf.__RoundToInt__SystemSingle__SystemInt32",
    {
      arity: 1,
      eval: ([a]) => {
        const value = toNumber(a);
        return value !== null ? bankersRound(value) : null;
      },
    },
  ],
  [
    "UnityEngineMathf.__Sin__SystemSingle__SystemSingle",
    {
      arity: 1,
      eval: ([a]) => {
        const value = toNumber(a);
        return value !== null ? Math.sin(value) : null;
      },
    },
  ],
  [
    "UnityEngineMathf.__Cos__SystemSingle__SystemSingle",
    {
      arity: 1,
      eval: ([a]) => {
        const value = toNumber(a);
        return value !== null ? Math.cos(value) : null;
      },
    },
  ],
  [
    "UnityEngineMathf.__Sqrt__SystemSingle__SystemSingle",
    {
      arity: 1,
      eval: ([a]) => {
        const value = toNumber(a);
        return value !== null ? Math.sqrt(value) : null;
      },
    },
  ],
  [
    "UnityEngineMathf.__Tan__SystemSingle__SystemSingle",
    {
      arity: 1,
      eval: ([a]) => {
        const value = toNumber(a);
        return value !== null ? Math.tan(value) : null;
      },
    },
  ],
  [
    "UnityEngineMathf.__Atan2__SystemSingle_SystemSingle__SystemSingle",
    {
      arity: 2,
      eval: ([y, x]) => {
        const yNum = toNumber(y);
        const xNum = toNumber(x);
        if (yNum === null || xNum === null) return null;
        return Math.atan2(yNum, xNum);
      },
    },
  ],
  [
    "UnityEngineMathf.__Log__SystemSingle__SystemSingle",
    {
      arity: 1,
      eval: ([a]) => {
        const value = toNumber(a);
        return value !== null ? Math.log(value) : null;
      },
    },
  ],
  [
    "UnityEngineMathf.__Log10__SystemSingle__SystemSingle",
    {
      arity: 1,
      eval: ([a]) => {
        const value = toNumber(a);
        return value !== null ? Math.log10(value) : null;
      },
    },
  ],
  [
    "UnityEngineMathf.__Exp__SystemSingle__SystemSingle",
    {
      arity: 1,
      eval: ([a]) => {
        const value = toNumber(a);
        return value !== null ? Math.exp(value) : null;
      },
    },
  ],
  [
    "SystemString.__get_Length__SystemInt32",
    {
      arity: 1,
      eval: ([value]) => {
        const str = toStringValue(value);
        return str === null ? null : str.length;
      },
    },
  ],
  [
    "UnityEngineVector3.__Dot__UnityEngineVector3_UnityEngineVector3__SystemSingle",
    {
      arity: 2,
      eval: ([a, b]) => {
        if (!isVector3Value(a) || !isVector3Value(b)) return null;
        return a.x * b.x + a.y * b.y + a.z * b.z;
      },
    },
  ],
  [
    "UnityEngineVector3.__Distance__UnityEngineVector3_UnityEngineVector3__SystemSingle",
    {
      arity: 2,
      eval: ([a, b]) => {
        if (!isVector3Value(a) || !isVector3Value(b)) return null;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dz = a.z - b.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
      },
    },
  ],
  [
    "UnityEngineVector3.__SqrMagnitude__UnityEngineVector3__SystemSingle",
    {
      arity: 1,
      eval: ([value]) => {
        if (!isVector3Value(value)) return null;
        return value.x * value.x + value.y * value.y + value.z * value.z;
      },
    },
  ],
]);
