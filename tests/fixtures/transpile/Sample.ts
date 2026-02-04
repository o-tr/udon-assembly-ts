export enum SampleKind {
  First = 1,
  Second = 2,
}

export class Sample {
  public static describe(
    kind: SampleKind,
    name: string,
    label: string,
  ): string {
    if (kind === SampleKind.First) {
      return label;
    }
    return name;
  }

  public static add(value: number, delta: number): number {
    const total = value + delta;
    return total;
  }

  public static createDefault(): string {
    return "default";
  }
}

export class SampleData {
  public readonly id: number;
  public name: string;
  private score: number;

  constructor(id: number, name: string, score: number) {
    this.id = id;
    this.name = name;
    this.score = score;
  }

  public updateScore(delta: number): number {
    this.score = this.score + delta;
    return this.score;
  }

  public static createDefault(): SampleData {
    return new SampleData(1, "default", 0);
  }
}
