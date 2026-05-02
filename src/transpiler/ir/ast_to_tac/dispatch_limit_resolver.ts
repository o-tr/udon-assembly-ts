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

export function createDefaultDispatchLimitResolver(): DispatchLimitResolver {
  return {
    getLimit({ property, usedErasedFallback }) {
      if (usedErasedFallback && property === "isWin") return 512;
      return 100;
    },
  };
}
