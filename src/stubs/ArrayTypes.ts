/**
 * Udon array type stubs for UdonSharp.
 *
 * UdonSharp arrays cannot change length at runtime, so the length is modeled
 * at the type level with a recursive tuple.
 */
export type UdonArray<
  T,
  N extends number,
  R extends T[] = [],
> = R["length"] extends N ? R : UdonArray<T, N, [...R, T]>;
