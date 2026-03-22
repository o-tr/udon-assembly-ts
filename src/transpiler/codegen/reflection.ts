/**
 * Shared utility for appending UdonSharp reflection metadata to the data section.
 */

export type HeapDataEntry = [string, number, string, unknown];

/**
 * Append __refl_typeid, __refl_typename, __refl_typeids entries for a given class.
 * typeId is null — UdonSharp's runtime resolves types internally
 * and our computed hash would not match.
 */
export function appendReflectionData(
  dataSection: HeapDataEntry[],
  className: string,
): HeapDataEntry[] {
  let maxAddress = dataSection.reduce(
    (max, entry) => Math.max(max, entry[1]),
    -1,
  );
  const nextAddress = () => {
    maxAddress += 1;
    return maxAddress;
  };

  const entries: HeapDataEntry[] = [
    ["__refl_typeid", nextAddress(), "Int64", null],
    ["__refl_typename", nextAddress(), "String", className],
    ["__refl_typeids", nextAddress(), "Int64Array", null],
  ];

  return [...dataSection, ...entries];
}
