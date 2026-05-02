/**
 * Configurable dispatch table size limits for D-3 erased fallback paths.
 */

export interface DispatchLimitContext {
  property: string;
  usedErasedFallback: boolean;
}

export interface DispatchLimitResolver {
  getLimit(ctx: DispatchLimitContext): number;
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
      if (
        usedErasedFallback &&
        LARGE_ERASED_DISPATCH_PROPERTIES.has(property)
      ) {
        return LARGE_ERASED_DISPATCH_LIMIT;
      }
      return DEFAULT_DISPATCH_LIMIT;
    },
  };
}
