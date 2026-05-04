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
 * Default set of properties that receive the larger erased-fallback dispatch
 * table limit. Kept empty intentionally — project-specific names (e.g.
 * mahjong-scoring `isWin`) should be supplied via a custom
 * DispatchLimitResolver passed to ASTToTACConverter options. This prevents
 * unrelated user properties with the same name from silently inheriting the
 * wider 512-candidate limit.
 */
const LARGE_ERASED_DISPATCH_PROPERTIES: ReadonlySet<string> = new Set([]);

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
