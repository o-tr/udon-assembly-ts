import type { UdonArray } from "../../../src/stubs/ArrayTypes";

export class DataContainers {
  public static objectToDictionary(value: { id: number; name: string }): {
    id: number;
    name: string;
  } {
    return value;
  }

  public static arrayToList(values: number[]): number[] {
    return values;
  }

  public static createFixedArray(): UdonArray<number, 3> {
    return [1, 2, 3];
  }
}
