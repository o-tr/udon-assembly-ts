import { PrimitiveTypes } from "../../../frontend/type_symbols.js";
import { CopyInstruction } from "../../tac_instruction.js";
import { createVariable, type TACOperand } from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";
import { resolveConcreteClassName } from "./inline.js";
import { normalizeOperandToInt32 } from "./int32_normalization.js";

type InlineInstanceInfo = { prefix: string; className: string };

/**
 * Restore `${prefix}__handle` from the receiver operand when the receiver maps
 * to an SoA class.
 */
export function emitSoaHandleRestore(
  converter: ASTToTACConverter,
  instanceInfo: InlineInstanceInfo,
  receiverOperand: TACOperand,
): boolean {
  const concreteClass = resolveConcreteClassName(converter, instanceInfo);
  if (!converter.soaClasses.has(concreteClass)) return false;

  const hdlVar = normalizeOperandToInt32(converter, receiverOperand);
  converter.emit(
    new CopyInstruction(
      createVariable(`${instanceInfo.prefix}__handle`, PrimitiveTypes.int32),
      hdlVar,
    ),
  );
  return true;
}
