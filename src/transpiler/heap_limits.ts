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
