import { ExternTypes } from "../../../frontend/type_symbols.js";
import {
  BinaryOpInstruction,
  type PropertyGetInstruction,
  type PropertySetInstruction,
  type TACInstruction,
  TACInstructionKind,
} from "../../tac_instruction.js";
import {
  createConstant,
  type ConstantOperand,
  type TACOperand,
  TACOperandKind,
  type TemporaryOperand,
} from "../../tac_operand.js";
import { countTempUses } from "../utils/instructions.js";
import { sameOperand } from "../utils/operands.js";
import { getOperandType } from "./constant_folding.js";

type ComponentUpdate = {
  delta: number;
  object: TACOperand;
};

const isVector3 = (operand: TACOperand): boolean => {
  return getOperandType(operand).name === ExternTypes.vector3.name;
};

const extractComponentUpdate = (
  getInst: PropertyGetInstruction,
  addInst: BinaryOpInstruction,
  setInst: PropertySetInstruction,
  tempUses: Map<number, number>,
): ComponentUpdate | null => {
  if (!sameOperand(getInst.object, setInst.object)) return null;
  if (addInst.operator !== "+" && addInst.operator !== "-") return null;
  if (addInst.left.kind !== TACOperandKind.Temporary) return null;
  if (addInst.right.kind !== TACOperandKind.Constant) return null;
  if (getInst.dest.kind !== TACOperandKind.Temporary) return null;
  if (
    (addInst.left as TemporaryOperand).id !==
    (getInst.dest as TemporaryOperand).id
  ) {
    return null;
  }
  if (setInst.value.kind !== TACOperandKind.Temporary) return null;
  if (
    (setInst.value as TemporaryOperand).id !==
    (addInst.dest as TemporaryOperand).id
  ) {
    return null;
  }
  const constOp = addInst.right as ConstantOperand;
  if (typeof constOp.value !== "number") return null;
  const step = constOp.value;
  if (!Number.isFinite(step)) return null;

  const getUses = tempUses.get((getInst.dest as TemporaryOperand).id) ?? 0;
  const addUses = tempUses.get((addInst.dest as TemporaryOperand).id) ?? 0;
  if (getUses !== 1 || addUses !== 1) return null;

  const delta = addInst.operator === "-" ? -step : step;
  return { delta, object: getInst.object };
};

export const optimizeVectorSwizzle = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  if (instructions.length < 9) return instructions;

  const tempUses = countTempUses(instructions);
  const result: TACInstruction[] = [];

  let i = 0;
  while (i < instructions.length) {
    const window = instructions.slice(i, i + 9);
    if (window.length < 9) {
      result.push(...window);
      break;
    }

    const [gX, bX, sX, gY, bY, sY, gZ, bZ, sZ] = window;
    if (
      gX.kind !== TACInstructionKind.PropertyGet ||
      bX.kind !== TACInstructionKind.BinaryOp ||
      sX.kind !== TACInstructionKind.PropertySet ||
      gY.kind !== TACInstructionKind.PropertyGet ||
      bY.kind !== TACInstructionKind.BinaryOp ||
      sY.kind !== TACInstructionKind.PropertySet ||
      gZ.kind !== TACInstructionKind.PropertyGet ||
      bZ.kind !== TACInstructionKind.BinaryOp ||
      sZ.kind !== TACInstructionKind.PropertySet
    ) {
      result.push(instructions[i]);
      i += 1;
      continue;
    }

    const getX = gX as PropertyGetInstruction;
    const getY = gY as PropertyGetInstruction;
    const getZ = gZ as PropertyGetInstruction;
    const setX = sX as PropertySetInstruction;
    const setY = sY as PropertySetInstruction;
    const setZ = sZ as PropertySetInstruction;
    if (getX.property !== "x" || getY.property !== "y" || getZ.property !== "z") {
      result.push(instructions[i]);
      i += 1;
      continue;
    }
    if (setX.property !== "x" || setY.property !== "y" || setZ.property !== "z") {
      result.push(instructions[i]);
      i += 1;
      continue;
    }

    const updateX = extractComponentUpdate(
      getX,
      bX as BinaryOpInstruction,
      setX,
      tempUses,
    );
    const updateY = extractComponentUpdate(
      getY,
      bY as BinaryOpInstruction,
      setY,
      tempUses,
    );
    const updateZ = extractComponentUpdate(
      getZ,
      bZ as BinaryOpInstruction,
      setZ,
      tempUses,
    );

    if (!updateX || !updateY || !updateZ) {
      result.push(instructions[i]);
      i += 1;
      continue;
    }

    if (!sameOperand(updateX.object, updateY.object)) {
      result.push(instructions[i]);
      i += 1;
      continue;
    }
    if (!sameOperand(updateX.object, updateZ.object)) {
      result.push(instructions[i]);
      i += 1;
      continue;
    }
    if (!isVector3(updateX.object)) {
      result.push(instructions[i]);
      i += 1;
      continue;
    }

    const vectorConst = createConstant(
      { x: updateX.delta, y: updateY.delta, z: updateZ.delta },
      ExternTypes.vector3,
    );
    result.push(
      new BinaryOpInstruction(
        updateX.object,
        updateX.object,
        "+",
        vectorConst,
      ),
    );

    i += 9;
  }

  return result;
};
