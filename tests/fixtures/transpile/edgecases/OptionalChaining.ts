export class OptionalChaining {
  public static access(o: { a?: { b: number } } | null) {
    // optional chaining is declared unsupported, but include fixture to observe behavior
    return o?.a?.b;
  }
}
