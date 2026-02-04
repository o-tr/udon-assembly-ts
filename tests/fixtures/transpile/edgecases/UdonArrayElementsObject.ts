import type { UdonArray } from "../../../../src/stubs/ArrayTypes";

export class UdonArrayElementsObject {
  public static make(): UdonArray<{ id: number; name: string }, 2> {
    return [
      { id: 1, name: "one" },
      { id: 2, name: "two" },
    ];
  }
}
