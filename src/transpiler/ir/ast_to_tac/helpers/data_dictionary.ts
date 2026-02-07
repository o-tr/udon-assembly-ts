import {
  ExternTypes,
  ObjectType,
  PrimitiveTypes,
} from "../../../frontend/type_symbols.js";
import type { ObjectLiteralPropertyNode } from "../../../frontend/types.js";
import {
  AssignmentInstruction,
  BinaryOpInstruction,
  CallInstruction,
  ConditionalJumpInstruction,
  LabelInstruction,
  MethodCallInstruction,
  PropertyGetInstruction,
  UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import { createConstant, type TACOperand } from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";

export function emitDictionaryFromProperties(
  this: ASTToTACConverter,
  properties: ObjectLiteralPropertyNode[],
): TACOperand {
  const hasSpread = properties.some((prop) => prop.kind === "spread");
  if (hasSpread) {
    const listResult = this.newTemp(ExternTypes.dataList);
    const listCtorSig = this.requireExternSignature(
      "DataList",
      "ctor",
      "method",
      [],
      "DataList",
    );
    this.instructions.push(new CallInstruction(listResult, listCtorSig, []));

    let pendingProps: ObjectLiteralPropertyNode[] = [];
    const flushPending = (): void => {
      if (pendingProps.length === 0) return;
      const dictSegment = this.emitDictionaryFromProperties(pendingProps);
      const dictToken = this.wrapDataToken(dictSegment);
      this.instructions.push(
        new MethodCallInstruction(undefined, listResult, "Add", [dictToken]),
      );
      pendingProps = [];
    };

    for (const prop of properties) {
      if (prop.kind === "spread") {
        flushPending();
        const spreadValue = this.visitExpression(prop.value);
        const spreadToken = this.wrapDataToken(spreadValue);
        this.instructions.push(
          new MethodCallInstruction(undefined, listResult, "Add", [
            spreadToken,
          ]),
        );
        continue;
      }
      pendingProps.push(prop);
    }
    flushPending();

    const inlineResult = this.visitInlineStaticMethodCall(
      "DataDictionaryHelpers",
      "Merge",
      [listResult],
    );
    if (inlineResult) return inlineResult;
    const mergeResult = this.newTemp(ExternTypes.dataDictionary);
    this.instructions.push(
      new CallInstruction(mergeResult, "DataDictionaryHelpers.Merge", [
        listResult,
      ]),
    );
    return mergeResult;
  }

  const dictResult = this.newTemp(ExternTypes.dataDictionary);
  const dictCtorSig = this.requireExternSignature(
    "DataDictionary",
    "ctor",
    "method",
    [],
    "DataDictionary",
  );
  this.instructions.push(new CallInstruction(dictResult, dictCtorSig, []));

  for (const prop of properties) {
    if (prop.kind !== "property") continue;
    const keyToken = this.wrapDataToken(
      createConstant(prop.key, PrimitiveTypes.string),
    );
    const value = this.visitExpression(prop.value);
    const valueToken = this.wrapDataToken(value);
    this.instructions.push(
      new MethodCallInstruction(undefined, dictResult, "SetValue", [
        keyToken,
        valueToken,
      ]),
    );
  }

  return dictResult;
}

export function emitDataDictionaryKeys(
  this: ASTToTACConverter,
  target: TACOperand,
): TACOperand {
  const result = this.newTemp(ExternTypes.dataList);
  this.instructions.push(
    new MethodCallInstruction(result, target, "GetKeys", []),
  );
  return result;
}

export function emitDataDictionaryValues(
  this: ASTToTACConverter,
  target: TACOperand,
): TACOperand {
  const result = this.newTemp(ExternTypes.dataList);
  this.instructions.push(
    new MethodCallInstruction(result, target, "GetValues", []),
  );
  return result;
}

export function emitDataDictionaryEntries(
  this: ASTToTACConverter,
  target: TACOperand,
): TACOperand {
  const result = this.newTemp(ExternTypes.dataList);
  const listCtorSig = this.requireExternSignature(
    "DataList",
    "ctor",
    "method",
    [],
    "DataList",
  );
  this.instructions.push(new CallInstruction(result, listCtorSig, []));

  const keysList = this.newTemp(ExternTypes.dataList);
  this.instructions.push(
    new MethodCallInstruction(keysList, target, "GetKeys", []),
  );
  const valuesList = this.newTemp(ExternTypes.dataList);
  this.instructions.push(
    new MethodCallInstruction(valuesList, target, "GetValues", []),
  );

  const indexVar = this.newTemp(PrimitiveTypes.int32);
  const lengthVar = this.newTemp(PrimitiveTypes.int32);
  this.instructions.push(
    new AssignmentInstruction(
      indexVar,
      createConstant(0, PrimitiveTypes.int32),
    ),
  );
  this.instructions.push(
    new PropertyGetInstruction(lengthVar, keysList, "Count"),
  );

  const loopStart = this.newLabel("entries_start");
  const loopContinue = this.newLabel("entries_continue");
  const loopEnd = this.newLabel("entries_end");

  this.instructions.push(new LabelInstruction(loopStart));
  const condTemp = this.newTemp(PrimitiveTypes.boolean);
  this.instructions.push(
    new BinaryOpInstruction(condTemp, indexVar, "<", lengthVar),
  );
  this.instructions.push(new ConditionalJumpInstruction(condTemp, loopEnd));

  const keyTemp = this.newTemp(ObjectType);
  this.instructions.push(
    new MethodCallInstruction(keyTemp, keysList, "get_Item", [indexVar]),
  );
  const valueTemp = this.newTemp(ObjectType);
  this.instructions.push(
    new MethodCallInstruction(valueTemp, valuesList, "get_Item", [indexVar]),
  );

  const pairList = this.newTemp(ExternTypes.dataList);
  this.instructions.push(new CallInstruction(pairList, listCtorSig, []));
  const keyToken = this.wrapDataToken(keyTemp);
  const valueToken = this.wrapDataToken(valueTemp);
  this.instructions.push(
    new MethodCallInstruction(undefined, pairList, "Add", [keyToken]),
  );
  this.instructions.push(
    new MethodCallInstruction(undefined, pairList, "Add", [valueToken]),
  );

  const pairToken = this.wrapDataToken(pairList);
  this.instructions.push(
    new MethodCallInstruction(undefined, result, "Add", [pairToken]),
  );

  this.instructions.push(new LabelInstruction(loopContinue));
  this.instructions.push(
    new BinaryOpInstruction(
      indexVar,
      indexVar,
      "+",
      createConstant(1, PrimitiveTypes.int32),
    ),
  );
  this.instructions.push(new UnconditionalJumpInstruction(loopStart));
  this.instructions.push(new LabelInstruction(loopEnd));

  return result;
}
