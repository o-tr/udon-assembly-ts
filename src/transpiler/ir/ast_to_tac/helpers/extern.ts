import { resolveExternSignature } from "../../../codegen/extern_signatures.js";
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
