import {
  type ArrayAccessInstruction as TACArrayAccessInstruction,
  type ArrayAssignmentInstruction as TACArrayAssignmentInstruction,
  type AssignmentInstruction as TACAssignmentInstruction,
  type BinaryOpInstruction as TACBinaryOpInstruction,
  type CallInstruction as TACCallInstruction,
  type CastInstruction as TACCastInstruction,
  type ConditionalJumpInstruction as TACConditionalJumpInstruction,
  type CopyInstruction as TACCopyInstruction,
  type TACInstruction,
  TACInstructionKind,
  type LabelInstruction as TACLabelInstruction,
  type MethodCallInstruction as TACMethodCallInstruction,
  type PropertyGetInstruction as TACPropertyGetInstruction,
  type PropertySetInstruction as TACPropertySetInstruction,
  type ReturnInstruction as TACReturnInstruction,
  type UnaryOpInstruction as TACUnaryOpInstruction,
  type UnconditionalJumpInstruction as TACUnconditionalJumpInstruction,
} from "../../ir/tac_instruction.js";
import type {
  ConstantOperand,
  LabelOperand,
  TemporaryOperand,
  VariableOperand,
} from "../../ir/tac_operand.js";
import { resolveExternSignature } from "../extern_signatures.js";
import {
  CopyInstruction,
  createUdonExternSignature,
  ExternInstruction,
  JumpIfFalseInstruction,
  JumpInstruction,
  LabelInstruction,
  PushInstruction,
} from "../udon_instruction.js";
import type { TACToUdonConverter } from "./converter.js";

export function convertInstruction(
  this: TACToUdonConverter,
  inst: TACInstruction,
): void {
  const isUdonExternSignature = (signature: string): boolean => {
    return /^[A-Za-z0-9._]+\.__[A-Za-z0-9_]+__(?:[A-Za-z0-9_]+)?__[A-Za-z0-9_]+$/.test(
      signature,
    );
  };

  switch (inst.kind) {
    case TACInstructionKind.Assignment: // fallthrough
    case TACInstructionKind.Copy: {
      const assignInst = inst as TACAssignmentInstruction | TACCopyInstruction;
      this.pushOperand(assignInst.src);
      const destAddr = this.getOperandAddress(assignInst.dest);
      this.instructions.push(new PushInstruction(destAddr));
      this.instructions.push(new CopyInstruction());
      break;
    }

    case TACInstructionKind.BinaryOp: {
      const binInst = inst as TACBinaryOpInstruction;
      this.pushOperand(binInst.left);
      this.pushOperand(binInst.right);

      // Call extern for operation
      const leftOp = binInst.left as
        | VariableOperand
        | ConstantOperand
        | TemporaryOperand;
      const leftType = leftOp.type?.udonType ?? "Single";
      const externSig = this.getExternForBinaryOp(binInst.operator, leftType);
      this.externSignatures.add(externSig);
      this.instructions.push(
        new ExternInstruction(this.getExternSymbol(externSig), true),
      );

      // Store result
      const destAddr = this.getOperandAddress(binInst.dest);
      this.instructions.push(new PushInstruction(destAddr));
      this.instructions.push(new CopyInstruction());
      break;
    }

    case TACInstructionKind.UnaryOp: {
      const unInst = inst as TACUnaryOpInstruction;
      this.pushOperand(unInst.operand);

      // Call extern for operation
      const operandOp = unInst.operand as
        | VariableOperand
        | ConstantOperand
        | TemporaryOperand;
      // operandOp might be a LabelOperand in theory if TAC is broken, but safe to assume it has type if valid
      // Actually, let's correspond to the fix I made earlier exactly
      const operandType = operandOp.type?.udonType ?? "Single";
      if (unInst.operator === "!" && operandType !== "Boolean") {
        const coerceSig = this.getConvertExternSignature(
          operandType,
          "Boolean",
        );
        this.externSignatures.add(coerceSig);
        this.instructions.push(
          new ExternInstruction(this.getExternSymbol(coerceSig), true),
        );
      }
      const externSig = this.getExternForUnaryOp(unInst.operator, operandType);
      this.externSignatures.add(externSig);
      this.instructions.push(
        new ExternInstruction(this.getExternSymbol(externSig), true),
      );

      // Store result
      const destAddr = this.getOperandAddress(unInst.dest);
      this.instructions.push(new PushInstruction(destAddr));
      this.instructions.push(new CopyInstruction());
      break;
    }

    case TACInstructionKind.Cast: {
      const castInst = inst as TACCastInstruction;
      const sourceType = this.getOperandUdonType(castInst.src);
      const targetType = this.getOperandUdonType(castInst.dest);

      if (sourceType === targetType) {
        this.pushOperand(castInst.src);
        const destAddr = this.getOperandAddress(castInst.dest);
        this.instructions.push(new PushInstruction(destAddr));
        this.instructions.push(new CopyInstruction());
        break;
      }

      this.pushOperand(castInst.src);

      if (this.isFloatType(sourceType) && this.isIntegerType(targetType)) {
        if (sourceType === "Single") {
          const toDoubleSig = this.getConvertExternSignature(
            "Single",
            "Double",
          );
          this.externSignatures.add(toDoubleSig);
          this.instructions.push(
            new ExternInstruction(this.getExternSymbol(toDoubleSig), true),
          );
        }
        const truncateSig = this.getTruncateExternSignature();
        this.externSignatures.add(truncateSig);
        this.instructions.push(
          new ExternInstruction(this.getExternSymbol(truncateSig), true),
        );

        const toTargetSig = this.getConvertExternSignature(
          "Double",
          targetType,
        );
        this.externSignatures.add(toTargetSig);
        this.instructions.push(
          new ExternInstruction(this.getExternSymbol(toTargetSig), true),
        );
      } else {
        const toTargetSig = this.getConvertExternSignature(
          sourceType,
          targetType,
        );
        this.externSignatures.add(toTargetSig);
        this.instructions.push(
          new ExternInstruction(this.getExternSymbol(toTargetSig), true),
        );
      }

      const destAddr = this.getOperandAddress(castInst.dest);
      this.instructions.push(new PushInstruction(destAddr));
      this.instructions.push(new CopyInstruction());
      break;
    }

    case TACInstructionKind.ConditionalJump: {
      const condJump = inst as TACConditionalJumpInstruction;
      this.pushOperand(condJump.condition);
      const labelName = (condJump.label as LabelOperand).name;
      this.instructions.push(new JumpIfFalseInstruction(labelName));
      break;
    }

    case TACInstructionKind.UnconditionalJump: {
      const jump = inst as TACUnconditionalJumpInstruction;
      const labelName = (jump.label as LabelOperand).name;
      this.instructions.push(new JumpInstruction(labelName));
      break;
    }

    case TACInstructionKind.Label: {
      const label = inst as TACLabelInstruction;
      const labelName = (label.label as LabelOperand).name;
      this.instructions.push(new LabelInstruction(labelName));
      break;
    }

    case TACInstructionKind.Call: {
      const call = inst as TACCallInstruction;
      // Push arguments
      for (const arg of call.args) {
        this.pushOperand(arg);
      }

      // Call function
      let externSig: string;
      if (call.func.startsWith("__ctor_")) {
        const typeName = call.func.replace("__ctor_", "");
        const tsParamTypes = call.args.map((arg) =>
          this.getOperandTsTypeName(arg),
        );
        const resolved = resolveExternSignature(
          typeName,
          "ctor",
          "method",
          tsParamTypes,
          typeName,
        );
        if (!resolved) {
          throw new Error(`Missing extern signature for ${typeName}.ctor`);
        }
        externSig = resolved;
      } else {
        externSig = call.func;
      }
      if (!isUdonExternSignature(externSig)) {
        const resolved = resolveExternSignature(call.func, "", "method");
        if (!resolved) {
          throw new Error(`Missing extern signature for ${call.func}`);
        }
        externSig = resolved;
      }
      this.externSignatures.add(externSig);
      const externSymbol = this.getExternSymbol(externSig);
      if (call.isTailCall) {
        // For tail calls, jump directly to the target after pushing args
        this.instructions.push(new JumpInstruction(externSymbol));
      } else {
        this.instructions.push(new ExternInstruction(externSymbol, true));

        // Store result if needed
        if (call.dest) {
          const destAddr = this.getOperandAddress(call.dest);
          this.instructions.push(new PushInstruction(destAddr));
          this.instructions.push(new CopyInstruction());
        }
      }
      break;
    }

    case TACInstructionKind.MethodCall: {
      const call = inst as TACMethodCallInstruction;
      this.pushOperand(call.object);
      for (const arg of call.args) {
        this.pushOperand(arg);
      }

      const paramTypes = [
        this.getOperandTypeName(call.object),
        ...call.args.map((arg) => this.getOperandTypeName(arg)),
      ];
      const tsParamTypes = call.args.map((arg) =>
        this.getOperandTsTypeName(arg),
      );
      const returnType = call.dest
        ? this.getOperandTypeName(call.dest)
        : "Void";
      const tsReturnType = call.dest
        ? this.getOperandTsTypeName(call.dest)
        : "void";
      const objectTypeName = this.getOperandTsTypeName(call.object);
      const methodName = call.method;
      const externSig =
        resolveExternSignature(
          objectTypeName,
          methodName,
          "method",
          tsParamTypes,
          tsReturnType,
        ) ?? createUdonExternSignature(methodName, paramTypes, returnType);
      this.externSignatures.add(externSig);
      const externSymbol = this.getExternSymbol(externSig);
      if (call.isTailCall) {
        this.instructions.push(new JumpInstruction(externSymbol));
      } else {
        this.instructions.push(new ExternInstruction(externSymbol, true));

        if (call.dest) {
          const destAddr = this.getOperandAddress(call.dest);
          this.instructions.push(new PushInstruction(destAddr));
          this.instructions.push(new CopyInstruction());
        }
      }
      break;
    }

    case TACInstructionKind.PropertyGet: {
      const getInst = inst as TACPropertyGetInstruction;
      this.pushOperand(getInst.object);

      const paramTypes = [this.getOperandTypeName(getInst.object)];
      const tsParamTypes: string[] = [];
      const objectTypeName = this.getOperandTsTypeName(getInst.object);
      const returnType = this.getOperandTypeName(getInst.dest);
      const tsReturnType = this.getOperandTsTypeName(getInst.dest);
      const externSig =
        resolveExternSignature(
          objectTypeName,
          getInst.property,
          "getter",
          tsParamTypes,
          tsReturnType,
        ) ??
        createUdonExternSignature(
          `get_${getInst.property}`,
          paramTypes,
          returnType,
        );
      this.externSignatures.add(externSig);
      this.instructions.push(
        new ExternInstruction(this.getExternSymbol(externSig), true),
      );

      const destAddr = this.getOperandAddress(getInst.dest);
      this.instructions.push(new PushInstruction(destAddr));
      this.instructions.push(new CopyInstruction());
      break;
    }

    case TACInstructionKind.PropertySet: {
      const setInst = inst as TACPropertySetInstruction;
      this.pushOperand(setInst.object);
      this.pushOperand(setInst.value);

      const paramTypes = [
        this.getOperandTypeName(setInst.object),
        this.getOperandTypeName(setInst.value),
      ];
      const tsParamTypes = [this.getOperandTsTypeName(setInst.value)];
      const objectTypeName = this.getOperandTsTypeName(setInst.object);
      const externSig =
        resolveExternSignature(
          objectTypeName,
          setInst.property,
          "setter",
          tsParamTypes,
          "void",
        ) ??
        createUdonExternSignature(
          `set_${setInst.property}`,
          paramTypes,
          "Void",
        );
      this.externSignatures.add(externSig);
      this.instructions.push(
        new ExternInstruction(this.getExternSymbol(externSig), true),
      );
      break;
    }

    case TACInstructionKind.ArrayAccess: {
      const arrayInst = inst as TACArrayAccessInstruction;
      this.pushOperand(arrayInst.array);
      this.pushOperand(arrayInst.index);
      const externSig = resolveExternSignature(
        "SystemArray",
        "Get",
        "method",
        ["int"],
        "object",
      );
      if (!externSig) {
        throw new Error("Missing extern signature for SystemArray.Get");
      }
      this.externSignatures.add(externSig);
      this.instructions.push(
        new ExternInstruction(this.getExternSymbol(externSig), true),
      );
      const destAddr = this.getOperandAddress(arrayInst.dest);
      this.instructions.push(new PushInstruction(destAddr));
      this.instructions.push(new CopyInstruction());
      break;
    }

    case TACInstructionKind.ArrayAssignment: {
      const arrayInst = inst as TACArrayAssignmentInstruction;
      this.pushOperand(arrayInst.array);
      this.pushOperand(arrayInst.index);
      this.pushOperand(arrayInst.value);
      const externSig = resolveExternSignature(
        "SystemArray",
        "Set",
        "method",
        ["int", "object"],
        "void",
      );
      if (!externSig) {
        throw new Error("Missing extern signature for SystemArray.Set");
      }
      this.externSignatures.add(externSig);
      this.instructions.push(
        new ExternInstruction(this.getExternSymbol(externSig), true),
      );
      break;
    }

    case TACInstructionKind.Return: {
      const retInst = inst as TACReturnInstruction;
      if (retInst.value) {
        this.pushOperand(retInst.value);
        const returnVar = retInst.returnVarName ?? "__returnValue_return";
        this.getReturnValueAddress(returnVar);
        this.instructions.push(new PushInstruction(returnVar));
        this.instructions.push(new CopyInstruction());
      }

      // Jump to exit address directly (0xFFFFFFFC)
      this.instructions.push(new JumpInstruction("0xFFFFFFFC"));
      break;
    }

    default: {
      const _exhaustive: never = inst.kind as never;
      throw new Error(`Unhandled TACInstructionKind: ${_exhaustive}`);
    }
  }
}
