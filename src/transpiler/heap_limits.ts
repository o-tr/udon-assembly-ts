export const UASM_HEAP_LIMIT = 512;
// Initial value for heap address reduction; allows empty data to evaluate to 0.
export const HEAP_SIZE_INITIAL_VALUE = -1;

// [name, address, type, value]
export type HeapDataEntry = [string, number, string, unknown];

export const computeHeapUsage = (dataSection: HeapDataEntry[]): number => {
  if (dataSection.length === 0) {
    return 0;
  }
  const heapSize = dataSection.reduce(
    (max, [, address]) => Math.max(max, address),
    HEAP_SIZE_INITIAL_VALUE,
  );
  return heapSize + 1;
};

export const buildHeapUsageBreakdown = (
  usageByClass: Map<string, number>,
  heapUsage: number,
  defaultClass: string,
  inlineClassNames?: Set<string>,
): string => {
  const updatedUsage = new Map(usageByClass);
  if (inlineClassNames) {
    for (const inlineClass of inlineClassNames) {
      if (!updatedUsage.has(inlineClass)) {
        updatedUsage.set(inlineClass, 0);
      }
    }
  }
  const totalUsage = Array.from(updatedUsage.values()).reduce(
    (sum, count) => sum + count,
    0,
  );
  if (totalUsage < heapUsage) {
    updatedUsage.set(
      defaultClass,
      (updatedUsage.get(defaultClass) ?? 0) + (heapUsage - totalUsage),
    );
  }

  return Array.from(updatedUsage.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([className, count]) => `  - ${className}: ${count}`)
    .join("\n");
};
