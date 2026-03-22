import { resolveExternSignature } from "../../../codegen/extern_signatures.js";
import type { TypeSymbol } from "../../../frontend/type_symbols.js";
import { ObjectType, PrimitiveTypes } from "../../../frontend/type_symbols.js";
import type { ASTToTACConverter } from "../converter.js";

export function requireExternSignature(
  this: ASTToTACConverter,
  typeName: string,
  memberName: string,
  accessType: "method" | "getter" | "setter",
  paramTypes?: string[],
  returnType?: string,
): string {
  const externSig = resolveExternSignature(
    typeName,
    memberName,
    accessType,
    paramTypes,
    returnType,
  );
  if (!externSig) {
    throw new Error(`Missing extern signature for ${typeName}.${memberName}`);
  }
  return externSig;
}

export const resolveExternReturnType = (
  externSig: string,
): TypeSymbol | null => {
  const parts = externSig.split("__");
  if (parts.length < 2) return null;
  const returnToken = parts[parts.length - 1];
  if (returnToken === "Void" || returnToken === "SystemVoid") {
    return PrimitiveTypes.void;
  }
  if (returnToken.startsWith("System")) {
    const typeName = returnToken.slice("System".length);
    switch (typeName) {
      case "Boolean":
        return PrimitiveTypes.boolean;
      case "Byte":
        return PrimitiveTypes.byte;
      case "SByte":
        return PrimitiveTypes.sbyte;
      case "Int16":
        return PrimitiveTypes.int16;
      case "UInt16":
        return PrimitiveTypes.uint16;
      case "Int32":
        return PrimitiveTypes.int32;
      case "UInt32":
        return PrimitiveTypes.uint32;
      case "Int64":
        return PrimitiveTypes.int64;
      case "UInt64":
        return PrimitiveTypes.uint64;
      case "Single":
        return PrimitiveTypes.single;
      case "Double":
        return PrimitiveTypes.double;
      case "String":
        return PrimitiveTypes.string;
      case "Object":
        return ObjectType;
      default:
        return null;
    }
  }
  return null;
};
