// Compile-time heap caps per output format.
// UASM_HEAP_LIMIT (512): default UdonAssemblyProgramAsset heap size.
// TASM_HEAP_LIMIT (1048576): maximum Udon VM heap capacity (MAXIMUM_CAPACITY).
// UASM_RUNTIME_LIMIT (65536): practical Udon runtime threshold; crossing this
//   triggers a warning but does not block compilation.
export const UASM_HEAP_LIMIT = 512;
export const TASM_HEAP_LIMIT = 1048576;
export const UASM_RUNTIME_LIMIT = 65536;

// Initial value for heap address reduction; allows empty data to evaluate to 0.
const HEAP_SIZE_INITIAL_VALUE = -1;

// [name, address, type, value]
export type HeapDataEntry = [string, number, string, unknown];

export const computeHeapUsage = (dataSection: HeapDataEntry[]): number => {
  if (dataSection.length === 0) return 0;
  const heapSize = dataSection.reduce(
    (max, [, address]) => Math.max(max, address),
    HEAP_SIZE_INITIAL_VALUE,
  );
  return heapSize + 1;
};

/**
 * Build a flat "Class: N" breakdown of heap usage, sorted descending.
 *
 * Any gap between tracked per-class totals and actual heap usage is attributed
 * to defaultClass so the breakdown always sums to heapUsage. The deficit is
 * only added when there is tracked usage or the default class already has an
 * entry, to avoid creating a phantom entry on an empty map.
 *
 * Returns a string containing one "  - ClassName: N" line per entry, or a
 * "  - <no data>" fallback when the resulting map is empty.
 */
export const buildSimpleHeapBreakdown = (
  usageByClass: Map<string, number>,
  heapUsage: number,
  defaultClass: string,
): string => {
  const totalTracked = Array.from(usageByClass.values()).reduce(
    (sum, n) => sum + n,
    0,
  );
  if (
    totalTracked < heapUsage &&
    (totalTracked > 0 || usageByClass.has(defaultClass))
  ) {
    usageByClass.set(
      defaultClass,
      (usageByClass.get(defaultClass) ?? 0) + (heapUsage - totalTracked),
    );
  }
  const lines = Array.from(usageByClass.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([cls, n]) => `  - ${cls}: ${n}`)
    .join("\n");
  return lines || "  - <no data>";
};
