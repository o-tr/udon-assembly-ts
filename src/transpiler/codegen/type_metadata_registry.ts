// Maps TypeScript/C# type aliases to registry keys (stub class names).
// Only "string" and "Math" need normalization because they are the only
// types whose TS primitive name differs from the stub class name AND
// whose instances have methods/properties that users call.
// Other primitives (number, boolean) have no instance methods in Udon.
export function normalizeTypeName(typeName: string): string {
  if (typeName === "string" || typeName === "String") return "SystemString";
  if (typeName === "System.String") return "SystemString";
  if (typeName === "Math" || typeName === "System.Math") return "SystemMath";
  return typeName;
}

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

  unregisterType(tsTypeName: string): void {
    this.types.delete(normalizeTypeName(tsTypeName));
  }

  hasType(tsTypeName: string): boolean {
    return this.types.has(normalizeTypeName(tsTypeName));
  }

  isEmpty(): boolean {
    return this.types.size === 0;
  }

  getMemberMetadata(
    tsTypeName: string,
    memberName: string,
  ): MemberMetadata | undefined {
    const type = this.types.get(normalizeTypeName(tsTypeName));
    if (!type) return undefined;
    const candidates = type.members.get(memberName);
    return candidates?.[0];
  }

  getMemberOverloads(tsTypeName: string, memberName: string): MemberMetadata[] {
    const type = this.types.get(normalizeTypeName(tsTypeName));
    if (!type) return [];
    return type.members.get(memberName) ?? [];
  }

  resolveOverload(
    tsTypeName: string,
    memberName: string,
    argCount: number,
  ): MemberMetadata | undefined {
    const type = this.types.get(normalizeTypeName(tsTypeName));
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
