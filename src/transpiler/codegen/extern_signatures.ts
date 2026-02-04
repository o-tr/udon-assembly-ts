import { typeMetadataRegistry } from "./type_metadata_registry.js";
import {
  generateExternSignature,
  mapTypeScriptToCSharp,
} from "./udon_type_resolver.js";

function normalizeTypeName(typeName: string): string {
  if (typeName === "string" || typeName === "String") return "SystemString";
  if (typeName === "System.String") return "SystemString";
  if (typeName === "Math" || typeName === "System.Math") return "SystemMath";
  return typeName;
}

function isGenericPlaceholder(typeName: string): boolean {
  const base = typeName.endsWith("[]") ? typeName.slice(0, -2) : typeName;
  if (base === "T") return true;
  return /^T[A-Z0-9]\w*$/.test(base);
}

const NUMERIC_TYPES = new Set<string>([
  "System.Byte",
  "System.SByte",
  "System.Int16",
  "System.UInt16",
  "System.Int32",
  "System.UInt32",
  "System.Int64",
  "System.UInt64",
  "System.Single",
  "System.Double",
]);

function scoreParamMatch(candidate: string, actual: string): number | null {
  if (candidate === actual) return 2;
  if (isGenericPlaceholder(candidate)) return 1;
  if (candidate === "System.Object") return 1;
  if (NUMERIC_TYPES.has(candidate) && NUMERIC_TYPES.has(actual)) return 1;
  return null;
}

function selectOverload(
  overloads: ReturnType<typeof typeMetadataRegistry.getMemberOverloads>,
  mappedParams: string[],
): (typeof overloads)[number] | undefined {
  let best: { score: number; member: (typeof overloads)[number] } | null =
    null;
  for (const member of overloads) {
    if (member.paramCsharpTypes.length !== mappedParams.length) continue;
    let score = 0;
    let matched = true;
    for (let i = 0; i < member.paramCsharpTypes.length; i += 1) {
      const paramScore = scoreParamMatch(
        member.paramCsharpTypes[i],
        mappedParams[i],
      );
      if (paramScore === null) {
        matched = false;
        break;
      }
      score += paramScore;
    }
    if (!matched) continue;
    if (!best || score > best.score) {
      best = { score, member };
    }
  }
  return best?.member;
}

export function resolveExternSignature(
  typeName: string,
  memberName: string,
  accessType: "method" | "getter" | "setter",
  paramTypes?: string[],
  returnType?: string,
): string | null {
  const normalizedTypeName = normalizeTypeName(typeName);
  const hasParamTypes = paramTypes !== undefined;
  let metadata =
    hasParamTypes && paramTypes
      ? (() => {
          const overloads = typeMetadataRegistry.getMemberOverloads(
            normalizedTypeName,
            memberName,
          );
          if (overloads.length === 0) return undefined;
          const mappedParams = paramTypes.map(mapTypeScriptToCSharp);
          return selectOverload(overloads, mappedParams);
        })()
      : typeMetadataRegistry.getMemberMetadata(normalizedTypeName, memberName);

  if (metadata) {
    if (metadata.externSignature) {
      return metadata.externSignature;
    }

    if (metadata.kind === "property") {
      const propertyName = metadata.memberName;
      const methodName =
        accessType === "setter" ? `set_${propertyName}` : `get_${propertyName}`;
      const params =
        accessType === "setter" ? [metadata.returnCsharpType] : [];
      const returnCsharp =
        accessType === "setter" ? "System.Void" : metadata.returnCsharpType;
      return generateExternSignature(
        metadata.ownerCsharpType,
        methodName,
        params,
        returnCsharp,
      );
    }

    const methodName =
      accessType === "getter"
        ? `get_${metadata.memberName}`
        : accessType === "setter"
          ? `set_${metadata.memberName}`
          : metadata.memberName;
    return generateExternSignature(
      metadata.ownerCsharpType,
      methodName,
      metadata.paramCsharpTypes,
      metadata.returnCsharpType,
    );
  }

  if (paramTypes && returnType) {
    const csharpOwner = mapTypeScriptToCSharp(typeName);
    const csharpParams = paramTypes.map(mapTypeScriptToCSharp);
    const csharpReturn = mapTypeScriptToCSharp(returnType);
    const methodName =
      accessType === "getter"
        ? `get_${memberName}`
        : accessType === "setter"
          ? `set_${memberName}`
          : memberName;
    return generateExternSignature(
      csharpOwner,
      methodName,
      csharpParams,
      csharpReturn,
    );
  }

  return null;
}

export function resolveConstructorSignature(typeName: string): string | null {
  return resolveExternSignature(typeName, "ctor", "method");
}
