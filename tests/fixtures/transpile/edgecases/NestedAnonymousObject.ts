export class NestedAnonymousObject {
  public static make(): { a: { b: { c: number } } } {
    return { a: { b: { c: 42 } } };
  }
}
