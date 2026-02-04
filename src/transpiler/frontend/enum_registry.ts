/**
 * Registry for enum definitions
 */

export type EnumKind = "number" | "string";

export interface EnumMemberInfo {
  name: string;
  value: number | string;
}

interface EnumInfo {
  kind: EnumKind;
  members: Map<string, number | string>;
}

export class EnumRegistry {
  private enums: Map<string, EnumInfo> = new Map();

  constructor() {
    this.register("NetworkEventTarget", "number", [
      { name: "All", value: 0 },
      { name: "Owner", value: 1 },
    ]);
  }

  register(name: string, kind: EnumKind, members: EnumMemberInfo[]): void {
    const map = new Map<string, number | string>();
    for (const member of members) {
      map.set(member.name, member.value);
    }
    this.enums.set(name, { kind, members: map });
  }

  resolve(enumName: string, memberName: string): number | string | undefined {
    return this.enums.get(enumName)?.members.get(memberName);
  }

  getEnumKind(name: string): EnumKind | undefined {
    return this.enums.get(name)?.kind;
  }

  isEnum(name: string): boolean {
    return this.enums.has(name);
  }
}
