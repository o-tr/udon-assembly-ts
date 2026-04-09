/**
 * Shared test utilities for unit tests.
 */

/**
 * Extract lines in the _start section (from _start label to its LAST return).
 * Scopes the search to the next top-level label so additional methods after
 * _start don't contaminate the result. Uses the last return within that range
 * to avoid cutting short when a conditional branch has an early return.
 */
export function getStartSection(tac: string): string {
  const lines = tac.split("\n");
  const startIdx = lines.findIndex((line) => /^_start:$/.test(line.trim()));
  if (startIdx < 0) return "";
  // Find the next top-level method label after _start (e.g. _update:, __0_foo:)
  // but not internal control-flow labels (viface_end_0:, forof_start_1:).
  const nextLabelIdx = lines.findIndex(
    (line, i) =>
      i > startIdx && /^_{1,2}[A-Za-z0-9][A-Za-z0-9_]*:$/.test(line.trim()),
  );
  const searchEnd = nextLabelIdx !== -1 ? nextLabelIdx : lines.length;
  let endIdx = -1;
  for (let i = searchEnd - 1; i > startIdx; i--) {
    if (/^return\b/.test(lines[i].trim())) {
      endIdx = i;
      break;
    }
  }
  return lines
    .slice(startIdx, endIdx !== -1 ? endIdx + 1 : searchEnd)
    .join("\n");
}
