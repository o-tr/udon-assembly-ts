/**
 * Configurable dispatch table size limits for D-3 erased fallback paths.
 */

export interface DispatchLimitContext {
  property: string;
  usedErasedFallback: boolean;
}

export interface DispatchLimitResolver {
  getLimit(ctx: DispatchLimitContext): number;
  /**
   * Return `true` for property names that should trigger the wide erased
   * fallback path (scanning all inline instances for the property) even
   * when the operand type is a plain `object` or `DataDictionary`.
   */
  isLargeErasedFallbackProperty(property: string): boolean;
}

/**
 * Properties that need a larger erased-fallback dispatch table in the
 * default mahjong-scoring project configuration. A user-project property
 * literally named the same would silently inherit the larger limit; projects
 * with different needs should supply a custom DispatchLimitResolver via
 * ASTToTACConverter options to keep the default tight at 100.
 */
const LARGE_ERASED_DISPATCH_PROPERTIES: ReadonlySet<string> = new Set([
  // mahjong scoring: many hand-result implementor classes share `isWin`.
  "isWin",
]);

const DEFAULT_DISPATCH_LIMIT = 100;
const LARGE_ERASED_DISPATCH_LIMIT = 512;

export function createDefaultDispatchLimitResolver(): DispatchLimitResolver {
  return {
    getLimit({ property, usedErasedFallback }) {
      // Only widen the limit when the erased fallback path is active; for
      // statically-resolved dispatch the default 100 cap is always sufficient.
      // Without this guard, properties such as "isWin" would incorrectly
      // receive the 512 limit even on non-erased paths.
      if (
        usedErasedFallback &&
        LARGE_ERASED_DISPATCH_PROPERTIES.has(property)
      ) {
        return LARGE_ERASED_DISPATCH_LIMIT;
      }
      return DEFAULT_DISPATCH_LIMIT;
    },
    isLargeErasedFallbackProperty(property) {
      return LARGE_ERASED_DISPATCH_PROPERTIES.has(property);
    },
  };
}
