export class ArrayWithAnonymousObjects {
  public static make(): { items: { id: number; name: string }[] } {
    return { items: [{ id: 1, name: "one" }] };
  }
}
