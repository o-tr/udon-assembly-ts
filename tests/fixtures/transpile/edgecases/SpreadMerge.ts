export class SpreadMerge {
  public static objMerge(a: { x: number }, b: { y: number }) {
    return { ...a, ...b };
  }

  public static arrConcat(a: number[], b: number[]) {
    return [...a, ...b];
  }
}
