export interface MemberMetadata {
  ownerCsharpType: string;
  memberName: string;
  kind: "method" | "property" | "constructor";
  paramCsharpTypes: string[];
  returnCsharpType: string;
  isStatic: boolean;
  externSignature?: string;
}

export interface TypeMetadata {
  csharpFullName: string;
  tsName: string;
  members: Map<string, MemberMetadata[]>;
}

export class TypeMetadataRegistry {
  private types: Map<string, TypeMetadata> = new Map();

  clear(): void {
    this.types.clear();
  }

  registerType(metadata: TypeMetadata): void {
    this.types.set(metadata.tsName, metadata);
  }

  hasType(tsTypeName: string): boolean {
    return this.types.has(tsTypeName);
  }

  isEmpty(): boolean {
    return this.types.size === 0;
  }

  getMemberMetadata(
    tsTypeName: string,
    memberName: string,
  ): MemberMetadata | undefined {
    const type = this.types.get(tsTypeName);
    if (!type) return undefined;
    const candidates = type.members.get(memberName);
    return candidates?.[0];
  }

  getMemberOverloads(
    tsTypeName: string,
    memberName: string,
  ): MemberMetadata[] {
    const type = this.types.get(tsTypeName);
    if (!type) return [];
    return type.members.get(memberName) ?? [];
  }

  resolveOverload(
    tsTypeName: string,
    memberName: string,
    argCount: number,
  ): MemberMetadata | undefined {
    const type = this.types.get(tsTypeName);
    if (!type) return undefined;
    const candidates = type.members.get(memberName) ?? [];
    return candidates.find(
      (member) => member.paramCsharpTypes.length === argCount,
    );
  }
}

export const typeMetadataRegistry = new TypeMetadataRegistry();

export function computeTypeId(typeName: string): bigint {
  const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < typeName.length; i++) {
    hash ^= BigInt(typeName.charCodeAt(i));
    hash = (hash * FNV_PRIME) & 0xffffffffffffffffn;
  }
  return hash;
}
