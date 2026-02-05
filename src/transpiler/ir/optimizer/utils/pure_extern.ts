export const bankersRound = (value: number): number => {
  const integer = Math.floor(value);
  const frac = value - integer;
  if (Math.abs(frac) === 0.5) {
    return integer % 2 === 0 ? integer : Math.ceil(value);
  }
  if (frac > 0.5) return integer + 1;
  return integer;
};

export const pureExternEvaluators = new Map<
  string,
  { arity: number; eval: (args: number[]) => number }
>([
  [
    "UnityEngineMathf.__Abs__SystemSingle__SystemSingle",
    { arity: 1, eval: ([a]) => Math.abs(a) },
  ],
  [
    "UnityEngineMathf.__Ceil__SystemSingle__SystemSingle",
    { arity: 1, eval: ([a]) => Math.ceil(a) },
  ],
  [
    "UnityEngineMathf.__CeilToInt__SystemSingle__SystemInt32",
    { arity: 1, eval: ([a]) => Math.ceil(a) },
  ],
  [
    "UnityEngineMathf.__Clamp__SystemSingle_SystemSingle_SystemSingle__SystemSingle",
    {
      arity: 3,
      eval: ([v, min, max]) => Math.min(Math.max(v, min), max),
    },
  ],
  [
    "UnityEngineMathf.__Clamp01__SystemSingle__SystemSingle",
    { arity: 1, eval: ([v]) => Math.min(Math.max(v, 0), 1) },
  ],
  [
    "UnityEngineMathf.__Floor__SystemSingle__SystemSingle",
    { arity: 1, eval: ([a]) => Math.floor(a) },
  ],
  [
    "UnityEngineMathf.__FloorToInt__SystemSingle__SystemInt32",
    { arity: 1, eval: ([a]) => Math.floor(a) },
  ],
  [
    "UnityEngineMathf.__Lerp__SystemSingle_SystemSingle_SystemSingle__SystemSingle",
    {
      arity: 3,
      eval: ([a, b, t]) => {
        const clamped = Math.min(Math.max(t, 0), 1);
        return a + (b - a) * clamped;
      },
    },
  ],
  [
    "UnityEngineMathf.__Max__SystemSingle_SystemSingle__SystemSingle",
    { arity: 2, eval: ([a, b]) => Math.max(a, b) },
  ],
  [
    "UnityEngineMathf.__Min__SystemSingle_SystemSingle__SystemSingle",
    { arity: 2, eval: ([a, b]) => Math.min(a, b) },
  ],
  [
    "UnityEngineMathf.__Pow__SystemSingle_SystemSingle__SystemSingle",
    { arity: 2, eval: ([a, b]) => a ** b },
  ],
  [
    "UnityEngineMathf.__Round__SystemSingle__SystemSingle",
    { arity: 1, eval: ([a]) => bankersRound(a) },
  ],
  [
    "UnityEngineMathf.__RoundToInt__SystemSingle__SystemInt32",
    { arity: 1, eval: ([a]) => bankersRound(a) },
  ],
  [
    "UnityEngineMathf.__Sin__SystemSingle__SystemSingle",
    { arity: 1, eval: ([a]) => Math.sin(a) },
  ],
  [
    "UnityEngineMathf.__Cos__SystemSingle__SystemSingle",
    { arity: 1, eval: ([a]) => Math.cos(a) },
  ],
  [
    "UnityEngineMathf.__Sqrt__SystemSingle__SystemSingle",
    { arity: 1, eval: ([a]) => Math.sqrt(a) },
  ],
  [
    "UnityEngineMathf.__Tan__SystemSingle__SystemSingle",
    { arity: 1, eval: ([a]) => Math.tan(a) },
  ],
]);
