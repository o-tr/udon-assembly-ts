import { NativeArrayTypeSymbol } from "../../frontend/type_symbols.js";
import { UdonType } from "../../frontend/types.js";
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
import {
  type ConstantOperand,
  type LabelOperand,
  TACOperandKind,
  type TemporaryOperand,
  type VariableOperand,
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
import {
  generateExternSignature,
  mapTypeScriptToCSharp,
} from "../udon_type_resolver.js";
import type { TACToUdonConverter } from "./converter.js";

export function convertInstruction(
  this: TACToUdonConverter,
  inst: TACInstruction,
): void {
  const isUdonExternSignature = (signature: string): boolean => {
    return /^[A-Za-z0-9._]+\.__\w+__\w+$/.test(signature);
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
      const leftOp = binInst.left as
        | VariableOperand
        | ConstantOperand
        | TemporaryOperand;
      const rightOp = binInst.right as
        | VariableOperand
        | ConstantOperand
        | TemporaryOperand;
      const leftType = leftOp.type?.udonType ?? UdonType.Single;
      const rightType = rightOp.type?.udonType ?? UdonType.Single;

      // Shift operators require Int32 right operand; skip promotion for those.
      const isShift = binInst.operator === "<<" || binInst.operator === ">>";
      // String comparison operators (<, >, <=, >=) are not supported by the
      // Udon VM — they must be lowered to String.Compare(a, b) <op> 0.
      const isStringComparison =
        (binInst.operator === "<" ||
          binInst.operator === ">" ||
          binInst.operator === "<=" ||
          binInst.operator === ">=") &&
        leftType === UdonType.String &&
        rightType === UdonType.String;
      // Detect null-literal equality/inequality: null comparisons must use
      // SystemObject.__op_Equality/Inequality regardless of the declared type
      // (the type mapper assigns DataDictionary to null literals via the
      // "object" mapping, but Udon requires Object-level comparison for null).
      // Only applies to == and != operators — other operators with null
      // operands are invalid and should not be silently promoted.
      const isNullComparison =
        (binInst.operator === "==" || binInst.operator === "!=") &&
        ((leftOp.kind === TACOperandKind.Constant &&
          (leftOp as ConstantOperand).value === null) ||
          (rightOp.kind === TACOperandKind.Constant &&
            (rightOp as ConstantOperand).value === null));
      if (isStringComparison) {
        // Udon VM does not have String.__op_GreaterThan/LessThan/etc.
        // Lower: a <op> b  →  String.Compare(a, b) <op> 0
        // String.Compare returns: negative (a < b), zero (a == b), positive (a > b)
        const compareResultName = `__tstrcmp_${this.nextAddress}`;
        this.variableAddresses.set(compareResultName, this.nextAddress++);
        this.variableTypes.set(compareResultName, "Int32");

        // Call String.Compare(left, right)
        this.pushOperand(binInst.left);
        this.pushOperand(binInst.right);
        this.instructions.push(new PushInstruction(compareResultName));
        const compareSig =
          "SystemString.__Compare__SystemString_SystemString__SystemInt32";
        this.externSignatures.add(compareSig);
        this.instructions.push(
          new ExternInstruction(this.getExternSymbol(compareSig), true),
        );

        // Compare result with 0: e.g. a > b ≡ Compare(a,b) > 0
        // Map the original operator to the comparison against 0:
        //   < → < 0,  > → > 0,  <= → <= 0,  >= → >= 0
        const destAddr = this.getOperandAddress(binInst.dest);
        this.instructions.push(new PushInstruction(compareResultName));
        this.pushConstant(0, "Int32");
        this.instructions.push(new PushInstruction(destAddr));
        const cmpSig = this.getExternForBinaryOp(binInst.operator, "Int32");
        this.externSignatures.add(cmpSig);
        this.instructions.push(
          new ExternInstruction(this.getExternSymbol(cmpSig), true),
        );

        // Override dest type to Boolean since comparison results are Boolean
        if (binInst.dest.kind === TACOperandKind.Temporary) {
          this.tempTypes.set((binInst.dest as TemporaryOperand).id, "Boolean");
        } else if (binInst.dest.kind === TACOperandKind.Variable) {
          const varName = this.normalizeVariableName(
            (binInst.dest as VariableOperand).name,
          );
          this.variableTypes.set(varName, "Boolean");
        }
        break;
      }

      let promotedType = leftType;
      if (isNullComparison) {
        promotedType = UdonType.Object;
      } else if (isShift) {
        // Shift operators always operate in the Int32 domain in Udon VM.
        // Coerce both operands to Int32; result is also Int32.
        promotedType = UdonType.Int32;
      } else if (leftType !== rightType) {
        const leftIsNum = this.isNumericType(leftType);
        const rightIsNum = this.isNumericType(rightType);
        if (leftIsNum && rightIsNum) {
          promotedType = this.getPromotedNumericType(
            leftType,
            rightType,
          ) as UdonType;
        } else {
          // Keep left type when operands are mixed/non-numeric so extern
          // selection stays consistent with the uncoerced left operand.
          promotedType = leftType;
        }
      }

      if (
        this.isNumericType(leftType) &&
        this.isNumericType(rightType) &&
        promotedType !== UdonType.Object &&
        (promotedType !== leftType || promotedType !== rightType)
      ) {
        // Helper: coerce a single operand, returning the push-able name.
        // For float→Int32 (shift operands), truncate toward zero first to
        // match JavaScript's ToInt32 semantics (Convert.ToInt32 rounds).
        const coerceOperand = (
          operand: typeof binInst.left,
          srcType: string,
        ): string | null => {
          if (srcType === promotedType) return null; // no conversion needed
          const tmpName = `__tcoerce_${this.nextAddress}`;
          this.variableAddresses.set(tmpName, this.nextAddress++);
          this.variableTypes.set(tmpName, promotedType);
          if (promotedType === UdonType.Int32 && this.isFloatType(srcType)) {
            // Float→Int32: truncate to Double first, then convert.
            let doubleSrc: string | number;
            if (srcType === "Double") {
              // Already Double — use the operand directly as truncation input.
              doubleSrc = this.getOperandAddress(operand);
            } else {
              const dblTmp = `__tcoerce_dbl_${this.nextAddress}`;
              this.variableAddresses.set(dblTmp, this.nextAddress++);
              this.variableTypes.set(dblTmp, "Double");
              this.pushOperand(operand);
              this.instructions.push(new PushInstruction(dblTmp));
              const toDblSig = this.getConvertExternSignature(
                srcType,
                "Double",
              );
              this.externSignatures.add(toDblSig);
              this.instructions.push(
                new ExternInstruction(this.getExternSymbol(toDblSig), true),
              );
              doubleSrc = dblTmp;
            }
            const truncTmp = `__tcoerce_trunc_${this.nextAddress}`;
            this.variableAddresses.set(truncTmp, this.nextAddress++);
            this.variableTypes.set(truncTmp, "Double");
            this.instructions.push(new PushInstruction(doubleSrc));
            this.instructions.push(new PushInstruction(truncTmp));
            const truncSig = this.getTruncateExternSignature();
            this.externSignatures.add(truncSig);
            this.instructions.push(
              new ExternInstruction(this.getExternSymbol(truncSig), true),
            );
            this.instructions.push(new PushInstruction(truncTmp));
            this.instructions.push(new PushInstruction(tmpName));
            const toIntSig = this.getConvertExternSignature(
              "Double",
              promotedType,
            );
            this.externSignatures.add(toIntSig);
            this.instructions.push(
              new ExternInstruction(this.getExternSymbol(toIntSig), true),
            );
          } else {
            this.pushOperand(operand);
            this.instructions.push(new PushInstruction(tmpName));
            const sig = this.getConvertExternSignature(srcType, promotedType);
            this.externSignatures.add(sig);
            this.instructions.push(
              new ExternInstruction(this.getExternSymbol(sig), true),
            );
          }
          return tmpName;
        };

        const leftTmp = coerceOperand(binInst.left, leftType);
        const rightTmp = coerceOperand(binInst.right, rightType);

        // Push (possibly coerced) operands for the binary op
        if (leftTmp) {
          this.instructions.push(new PushInstruction(leftTmp));
        } else {
          this.pushOperand(binInst.left);
        }
        if (rightTmp) {
          this.instructions.push(new PushInstruction(rightTmp));
        } else {
          this.pushOperand(binInst.right);
        }
      } else {
        this.pushOperand(binInst.left);
        this.pushOperand(binInst.right);
      }

      // Determine if the result needs to be truncated back to the dest type.
      // Comparison ops always return Boolean regardless of promoted type,
      // so only arithmetic ops can produce a wider-than-dest result.
      const destType = this.getOperandUdonType(binInst.dest);
      const isComparison =
        binInst.operator === "<" ||
        binInst.operator === ">" ||
        binInst.operator === "<=" ||
        binInst.operator === ">=" ||
        binInst.operator === "==" ||
        binInst.operator === "!=";
      // destType differs from promotedType: either narrowing (promoted wider
      // type back to original dest) or widening (e.g. Int32 result into Int64 dest).
      const needsResultConversion =
        !isComparison &&
        this.isNumericType(destType) &&
        promotedType !== destType;

      if (needsResultConversion) {
        // Write promoted result to a temp slot, then convert to dest type
        const promotedTmpName = `__tpromoted_${this.nextAddress}`;
        this.variableAddresses.set(promotedTmpName, this.nextAddress++);
        this.variableTypes.set(promotedTmpName, promotedType);
        this.instructions.push(new PushInstruction(promotedTmpName));

        const externSig = this.getExternForBinaryOp(
          binInst.operator,
          promotedType,
        );
        this.externSignatures.add(externSig);
        this.instructions.push(
          new ExternInstruction(this.getExternSymbol(externSig), true),
        );

        // Convert promoted result back to dest type
        const destAddr = this.getOperandAddress(binInst.dest);

        if (this.isFloatType(promotedType) && this.isIntegerType(destType)) {
          // Float→int requires Math.Truncate before Convert (matching
          // CastInstruction semantics). Convert to Double first if needed,
          // then truncate, then convert to target integer type.
          let doubleSrc = promotedTmpName;
          if (promotedType === "Single") {
            const dblTmp = `__tpromoted_dbl_${this.nextAddress}`;
            this.variableAddresses.set(dblTmp, this.nextAddress++);
            this.variableTypes.set(dblTmp, "Double");
            this.instructions.push(new PushInstruction(promotedTmpName));
            this.instructions.push(new PushInstruction(dblTmp));
            const toDblSig = this.getConvertExternSignature("Single", "Double");
            this.externSignatures.add(toDblSig);
            this.instructions.push(
              new ExternInstruction(this.getExternSymbol(toDblSig), true),
            );
            doubleSrc = dblTmp;
          }
          // Math.Truncate Double → Double
          const truncDblTmp = `__tpromoted_trunc_${this.nextAddress}`;
          this.variableAddresses.set(truncDblTmp, this.nextAddress++);
          this.variableTypes.set(truncDblTmp, "Double");
          this.instructions.push(new PushInstruction(doubleSrc));
          this.instructions.push(new PushInstruction(truncDblTmp));
          const truncateSig = this.getTruncateExternSignature();
          this.externSignatures.add(truncateSig);
          this.instructions.push(
            new ExternInstruction(this.getExternSymbol(truncateSig), true),
          );
          // Convert truncated Double → target integer type
          this.instructions.push(new PushInstruction(truncDblTmp));
          this.instructions.push(new PushInstruction(destAddr));
          const toIntSig = this.getConvertExternSignature("Double", destType);
          this.externSignatures.add(toIntSig);
          this.instructions.push(
            new ExternInstruction(this.getExternSymbol(toIntSig), true),
          );
        } else {
          // Numeric conversion: int→int, int→float, or float→float.
          // (float→int is handled above with Math.Truncate semantics.)
          this.instructions.push(new PushInstruction(promotedTmpName));
          this.instructions.push(new PushInstruction(destAddr));
          const convSig = this.getConvertExternSignature(
            promotedType,
            destType,
          );
          this.externSignatures.add(convSig);
          this.instructions.push(
            new ExternInstruction(this.getExternSymbol(convSig), true),
          );
        }
      } else {
        // Push result address before EXTERN (Udon VM calling convention)
        const destAddr = this.getOperandAddress(binInst.dest);
        this.instructions.push(new PushInstruction(destAddr));

        // Call extern for operation using the promoted type
        const externSig = this.getExternForBinaryOp(
          binInst.operator,
          promotedType,
        );
        this.externSignatures.add(externSig);
        this.instructions.push(
          new ExternInstruction(this.getExternSymbol(externSig), true),
        );
      }
      break;
    }

    case TACInstructionKind.UnaryOp: {
      const unInst = inst as TACUnaryOpInstruction;

      // Call extern for operation
      const operandOp = unInst.operand as
        | VariableOperand
        | ConstantOperand
        | TemporaryOperand;
      const operandType = operandOp.type?.udonType ?? "Single";

      if (unInst.operator === "!" && operandType === "String") {
        // String truthiness: !str <==> str.Length == 0
        // (length == 0 directly gives !str result, no separate negation needed)

        // Step 1: Get string length → Int32 temp
        this.pushOperand(unInst.operand);
        const lenTmpName = `__tcoerce_${this.nextAddress}`;
        this.variableAddresses.set(lenTmpName, this.nextAddress++);
        this.variableTypes.set(lenTmpName, "Int32");
        this.instructions.push(new PushInstruction(lenTmpName));
        const getLengthSig = "SystemString.__get_Length__SystemInt32";
        this.externSignatures.add(getLengthSig);
        this.instructions.push(
          new ExternInstruction(this.getExternSymbol(getLengthSig), true),
        );

        // Step 2: Compare length == 0 → dest (Boolean)
        this.instructions.push(new PushInstruction(lenTmpName));
        this.pushConstant(0, "Int32");
        const destAddr = this.getOperandAddress(unInst.dest);
        this.instructions.push(new PushInstruction(destAddr));
        // The TAC dest inherits String type from the operand; override to Boolean
        if (unInst.dest.kind === TACOperandKind.Temporary) {
          this.tempTypes.set((unInst.dest as TemporaryOperand).id, "Boolean");
        } else if (unInst.dest.kind === TACOperandKind.Variable) {
          const varName = this.normalizeVariableName(
            (unInst.dest as VariableOperand).name,
          );
          this.variableTypes.set(varName, "Boolean");
        }
        const eqSig = this.getExternForBinaryOp("==", "Int32");
        this.externSignatures.add(eqSig);
        this.instructions.push(
          new ExternInstruction(this.getExternSymbol(eqSig), true),
        );
      } else if (unInst.operator === "!" && operandType !== "Boolean") {
        if (operandType === UdonType.Object) {
          // Object → Boolean coercion: Udon VM uses simple COPY from Object
          // slot to Boolean slot (non-null = true, null = false), then negate.
          // Convert.ToBoolean(Object) does not exist in the VM.
          this.pushOperand(unInst.operand);
          const coerceTmpName = `__tcoerce_${this.nextAddress}`;
          this.variableAddresses.set(coerceTmpName, this.nextAddress++);
          this.variableTypes.set(coerceTmpName, "Boolean");
          this.instructions.push(new PushInstruction(coerceTmpName));
          this.instructions.push(new CopyInstruction());

          // Negate the Boolean
          this.instructions.push(new PushInstruction(coerceTmpName));
          const destAddr = this.getOperandAddress(unInst.dest);
          this.instructions.push(new PushInstruction(destAddr));
          const externSig = this.getExternForUnaryOp(
            unInst.operator,
            "Boolean",
          );
          this.externSignatures.add(externSig);
          this.instructions.push(
            new ExternInstruction(this.getExternSymbol(externSig), true),
          );
        } else {
          // Need to coerce to Boolean first, then negate
          // Step 1: Convert to Boolean (needs intermediate temp)
          this.pushOperand(unInst.operand);
          const coerceTmpName = `__tcoerce_${this.nextAddress}`;
          this.variableAddresses.set(coerceTmpName, this.nextAddress++);
          this.variableTypes.set(coerceTmpName, "Boolean");
          this.instructions.push(new PushInstruction(coerceTmpName));
          const coerceSig = this.getConvertExternSignature(
            operandType,
            "Boolean",
          );
          this.externSignatures.add(coerceSig);
          this.instructions.push(
            new ExternInstruction(this.getExternSymbol(coerceSig), true),
          );

          // Step 2: Negate the Boolean
          this.instructions.push(new PushInstruction(coerceTmpName));
          const destAddr = this.getOperandAddress(unInst.dest);
          this.instructions.push(new PushInstruction(destAddr));
          const externSig = this.getExternForUnaryOp(
            unInst.operator,
            "Boolean",
          );
          this.externSignatures.add(externSig);
          this.instructions.push(
            new ExternInstruction(this.getExternSymbol(externSig), true),
          );
        }
      } else {
        // Simple unary op: push operand, push dest, EXTERN
        this.pushOperand(unInst.operand);
        const destAddr = this.getOperandAddress(unInst.dest);
        this.instructions.push(new PushInstruction(destAddr));
        const externSig = this.getExternForUnaryOp(
          unInst.operator,
          operandType,
        );
        this.externSignatures.add(externSig);
        this.instructions.push(
          new ExternInstruction(this.getExternSymbol(externSig), true),
        );
      }
      break;
    }

    case TACInstructionKind.Cast: {
      const castInst = inst as TACCastInstruction;
      const sourceType = this.getOperandUdonType(castInst.src);
      const targetType = this.getOperandUdonType(castInst.dest);

      if (
        sourceType === targetType ||
        targetType === UdonType.Object ||
        targetType === "SystemObject" ||
        targetType === "System.Object" ||
        targetType === "object"
      ) {
        this.pushOperand(castInst.src);
        const destAddr = this.getOperandAddress(castInst.dest);
        this.instructions.push(new PushInstruction(destAddr));
        this.instructions.push(new CopyInstruction());
        break;
      }

      const destAddr = this.getOperandAddress(castInst.dest);

      if (this.isFloatType(sourceType) && this.isIntegerType(targetType)) {
        if (sourceType === "Single") {
          // Step 1: Convert Single → Double
          const castTmp0 = `__tcast_${this.nextAddress}`;
          this.variableAddresses.set(castTmp0, this.nextAddress++);
          this.variableTypes.set(castTmp0, "Double");
          this.pushOperand(castInst.src);
          this.instructions.push(new PushInstruction(castTmp0));
          const toDoubleSig = this.getConvertExternSignature(
            "Single",
            "Double",
          );
          this.externSignatures.add(toDoubleSig);
          this.instructions.push(
            new ExternInstruction(this.getExternSymbol(toDoubleSig), true),
          );

          // Step 2: Math.Truncate Double → Double
          const castTmp1 = `__tcast_${this.nextAddress}`;
          this.variableAddresses.set(castTmp1, this.nextAddress++);
          this.variableTypes.set(castTmp1, "Double");
          this.instructions.push(new PushInstruction(castTmp0));
          this.instructions.push(new PushInstruction(castTmp1));
          const truncateSig = this.getTruncateExternSignature();
          this.externSignatures.add(truncateSig);
          this.instructions.push(
            new ExternInstruction(this.getExternSymbol(truncateSig), true),
          );

          // Step 3: Convert Double → target type
          this.instructions.push(new PushInstruction(castTmp1));
          this.instructions.push(new PushInstruction(destAddr));
          const toTargetSig = this.getConvertExternSignature(
            "Double",
            targetType,
          );
          this.externSignatures.add(toTargetSig);
          this.instructions.push(
            new ExternInstruction(this.getExternSymbol(toTargetSig), true),
          );
        } else {
          // sourceType is Double, just truncate and convert
          // Step 1: Math.Truncate Double → Double
          const castTmp = `__tcast_${this.nextAddress}`;
          this.variableAddresses.set(castTmp, this.nextAddress++);
          this.variableTypes.set(castTmp, "Double");
          this.pushOperand(castInst.src);
          this.instructions.push(new PushInstruction(castTmp));
          const truncateSig = this.getTruncateExternSignature();
          this.externSignatures.add(truncateSig);
          this.instructions.push(
            new ExternInstruction(this.getExternSymbol(truncateSig), true),
          );

          // Step 2: Convert Double → target type
          this.instructions.push(new PushInstruction(castTmp));
          this.instructions.push(new PushInstruction(destAddr));
          const toTargetSig = this.getConvertExternSignature(
            "Double",
            targetType,
          );
          this.externSignatures.add(toTargetSig);
          this.instructions.push(
            new ExternInstruction(this.getExternSymbol(toTargetSig), true),
          );
        }
      } else {
        // Simple conversion: push source, push dest, EXTERN
        this.pushOperand(castInst.src);
        this.instructions.push(new PushInstruction(destAddr));
        const toTargetSig = this.getConvertExternSignature(
          sourceType,
          targetType,
        );
        this.externSignatures.add(toTargetSig);
        this.instructions.push(
          new ExternInstruction(this.getExternSymbol(toTargetSig), true),
        );
      }
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

      // Push return address before EXTERN if non-void (Udon VM calling convention)
      if (call.dest) {
        const destAddr = this.getOperandAddress(call.dest);
        this.instructions.push(new PushInstruction(destAddr));
      } else if (!externSig.endsWith("__SystemVoid")) {
        // Non-void call with discarded result: allocate a scratch slot
        // Extract return type from signature (segment after the last "__")
        const returnUdonType = externSig.substring(
          externSig.lastIndexOf("__") + 2,
        );
        const scratchName = `__tdiscard_${this.nextAddress}`;
        this.variableAddresses.set(scratchName, this.nextAddress++);
        this.variableTypes.set(scratchName, returnUdonType);
        this.instructions.push(new PushInstruction(scratchName));
      }

      this.instructions.push(new ExternInstruction(externSymbol, true));
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
        : "SystemVoid";
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

      // Push return address before EXTERN if non-void (Udon VM calling convention)
      if (call.dest) {
        const destAddr = this.getOperandAddress(call.dest);
        this.instructions.push(new PushInstruction(destAddr));
      } else if (!externSig.endsWith("__SystemVoid")) {
        // Non-void call with discarded result: allocate a scratch slot
        // Extract return type from signature (segment after the last "__")
        const returnUdonType = externSig.substring(
          externSig.lastIndexOf("__") + 2,
        );
        const scratchName = `__tdiscard_${this.nextAddress}`;
        this.variableAddresses.set(scratchName, this.nextAddress++);
        this.variableTypes.set(scratchName, returnUdonType);
        this.instructions.push(new PushInstruction(scratchName));
      }

      this.instructions.push(new ExternInstruction(externSymbol, true));
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

      // Push return address before EXTERN (Udon VM calling convention)
      const destAddr = this.getOperandAddress(getInst.dest);
      this.instructions.push(new PushInstruction(destAddr));

      this.instructions.push(
        new ExternInstruction(this.getExternSymbol(externSig), true),
      );
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
          "SystemVoid",
        );
      this.externSignatures.add(externSig);
      this.instructions.push(
        new ExternInstruction(this.getExternSymbol(externSig), true),
      );
      break;
    }

    case TACInstructionKind.ArrayAccess: {
      // Native typed-array element read: {ArrayType}.__Get__SystemInt32__{ElementType}
      const arrAccess = inst as TACArrayAccessInstruction;
      const arrType = (arrAccess.array as unknown as { type: unknown }).type;
      if (!(arrType instanceof NativeArrayTypeSymbol)) {
        throw new Error(
          "ArrayAccess instruction requires a NativeArrayTypeSymbol operand. " +
            "Use DataList get_Item/set_Item for all other arrays.",
        );
      }
      const csharpElem = mapTypeScriptToCSharp(arrType.elementType.name);
      const csharpArr = `${csharpElem}[]`;
      const getExternSig = generateExternSignature(
        csharpArr,
        "Get",
        ["System.Int32"],
        csharpElem,
      );
      this.pushOperand(arrAccess.array);
      this.pushOperand(arrAccess.index);
      const destAddr = this.getOperandAddress(arrAccess.dest);
      this.instructions.push(new PushInstruction(destAddr));
      this.externSignatures.add(getExternSig);
      this.instructions.push(
        new ExternInstruction(this.getExternSymbol(getExternSig), true),
      );
      break;
    }

    case TACInstructionKind.ArrayAssignment: {
      // Native typed-array element write: {ArrayType}.__Set__SystemInt32_{ElementType}__SystemVoid
      const arrAssign = inst as TACArrayAssignmentInstruction;
      const arrType = (arrAssign.array as unknown as { type: unknown }).type;
      if (!(arrType instanceof NativeArrayTypeSymbol)) {
        throw new Error(
          "ArrayAssignment instruction requires a NativeArrayTypeSymbol operand. " +
            "Use DataList get_Item/set_Item for all other arrays.",
        );
      }
      const csharpElem = mapTypeScriptToCSharp(arrType.elementType.name);
      const csharpArr = `${csharpElem}[]`;
      const setExternSig = generateExternSignature(
        csharpArr,
        "Set",
        ["System.Int32", csharpElem],
        "System.Void",
      );
      this.pushOperand(arrAssign.array);
      this.pushOperand(arrAssign.index);
      this.pushOperand(arrAssign.value);
      this.externSignatures.add(setExternSig);
      this.instructions.push(
        new ExternInstruction(this.getExternSymbol(setExternSig), true),
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
      this.instructions.push(new JumpInstruction(0xfffffffc));
      break;
    }

    case TACInstructionKind.Phi: {
      throw new Error("Phi instructions must be lowered before codegen");
    }

    default: {
      const _exhaustive: never = inst.kind as never;
      throw new Error(`Unhandled TACInstructionKind: ${_exhaustive}`);
    }
  }
}
