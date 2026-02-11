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
    // === ShallowClone最適化: spreadが1つだけ＆先頭にある場合 ===
    const spreadCount = properties.filter((p) => p.kind === "spread").length;
    if (spreadCount === 1 && properties[0].kind === "spread") {
      const spreadValue = this.visitExpression(properties[0].value);
      const spreadType = this.getOperandType(spreadValue);

      if (spreadType.udonType === ExternTypes.dataDictionary.udonType) {
        // ShallowClone最適化パス
        const cloneResult = this.newTemp(ExternTypes.dataDictionary);
        this.instructions.push(
          new MethodCallInstruction(
            cloneResult,
            spreadValue,
            "ShallowClone",
            [],
          ),
        );
        // 残りのプロパティを順次SetValue（左→右の評価順序を維持）
        for (let i = 1; i < properties.length; i++) {
          const prop = properties[i];
          if (prop.kind !== "property") continue;
          const keyToken = this.wrapDataToken(
            createConstant(prop.key, PrimitiveTypes.string),
          );
          const value = this.visitExpression(prop.value);
          const valueToken = this.wrapDataToken(value);
          this.instructions.push(
            new MethodCallInstruction(undefined, cloneResult, "SetValue", [
              keyToken,
              valueToken,
            ]),
          );
        }
        return cloneResult;
      }

      // 型不一致フォールバック: 評価済みspreadValueを再利用してmerge
      const listResult = this.newTemp(ExternTypes.dataList);
      const listCtorSig = this.requireExternSignature(
        "DataList",
        "ctor",
        "method",
        [],
        "DataList",
      );
      this.instructions.push(new CallInstruction(listResult, listCtorSig, []));
      const spreadToken = this.wrapDataToken(spreadValue);
      this.instructions.push(
        new MethodCallInstruction(undefined, listResult, "Add", [spreadToken]),
      );
      const remaining = properties.slice(1);
      if (remaining.length > 0) {
        const dictSegment = this.emitDictionaryFromProperties(remaining);
        const dictToken = this.wrapDataToken(dictSegment);
        this.instructions.push(
          new MethodCallInstruction(undefined, listResult, "Add", [dictToken]),
        );
      }
      const inlineResult = this.visitInlineStaticMethodCall(
        "DataDictionaryHelpers",
        "Merge",
        [listResult],
      );
      if (inlineResult) return inlineResult;
      return emitInlineDictionaryMerge.call(this, listResult);
    }

    // === 既存のmergeパス（複数spread or spread先頭でない場合） ===
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
    return emitInlineDictionaryMerge.call(this, listResult);
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

/**
 * Emit inline dictionary merge when DataDictionaryHelpers is not available.
 * Iterates the DataList of DataToken-wrapped DataDictionaries and copies
 * all entries into a single result DataDictionary.
 */
function emitInlineDictionaryMerge(
  this: ASTToTACConverter,
  segments: TACOperand,
): TACOperand {
  const dictCtorSig = this.requireExternSignature(
    "DataDictionary",
    "ctor",
    "method",
    [],
    "DataDictionary",
  );
  const result = this.newTemp(ExternTypes.dataDictionary);
  this.instructions.push(new CallInstruction(result, dictCtorSig, []));

  // Outer loop: iterate segments DataList
  const segCount = this.newTemp(PrimitiveTypes.int32);
  this.instructions.push(
    new PropertyGetInstruction(segCount, segments, "Count"),
  );
  const segIdx = this.newTemp(PrimitiveTypes.int32);
  this.instructions.push(
    new AssignmentInstruction(segIdx, createConstant(0, PrimitiveTypes.int32)),
  );

  const outerStart = this.newLabel("merge_outer");
  const outerEnd = this.newLabel("merge_outer_end");
  this.instructions.push(new LabelInstruction(outerStart));
  const outerCond = this.newTemp(PrimitiveTypes.boolean);
  this.instructions.push(
    new BinaryOpInstruction(outerCond, segIdx, "<", segCount),
  );
  // ConditionalJumpInstruction = JUMP_IF_FALSE: exits loop when segIdx >= segCount
  this.instructions.push(new ConditionalJumpInstruction(outerCond, outerEnd));

  // Get segment DataToken and unwrap to DataDictionary
  const segToken = this.newTemp(ExternTypes.dataToken);
  this.instructions.push(
    new MethodCallInstruction(segToken, segments, "get_Item", [segIdx]),
  );
  const segDict = this.newTemp(ExternTypes.dataDictionary);
  this.instructions.push(
    new PropertyGetInstruction(segDict, segToken, "DataDictionary"),
  );

  // Inner loop: iterate keys of segment dictionary
  const keys = this.newTemp(ExternTypes.dataList);
  this.instructions.push(
    new MethodCallInstruction(keys, segDict, "GetKeys", []),
  );
  const keyCount = this.newTemp(PrimitiveTypes.int32);
  this.instructions.push(new PropertyGetInstruction(keyCount, keys, "Count"));
  const keyIdx = this.newTemp(PrimitiveTypes.int32);
  this.instructions.push(
    new AssignmentInstruction(keyIdx, createConstant(0, PrimitiveTypes.int32)),
  );

  const innerStart = this.newLabel("merge_inner");
  const innerEnd = this.newLabel("merge_inner_end");
  this.instructions.push(new LabelInstruction(innerStart));
  const innerCond = this.newTemp(PrimitiveTypes.boolean);
  this.instructions.push(
    new BinaryOpInstruction(innerCond, keyIdx, "<", keyCount),
  );
  // ConditionalJumpInstruction = JUMP_IF_FALSE: exits loop when keyIdx >= keyCount
  this.instructions.push(new ConditionalJumpInstruction(innerCond, innerEnd));

  // Copy key-value pair
  const key = this.newTemp(ExternTypes.dataToken);
  this.instructions.push(
    new MethodCallInstruction(key, keys, "get_Item", [keyIdx]),
  );
  const value = this.newTemp(ExternTypes.dataToken);
  this.instructions.push(
    new MethodCallInstruction(value, segDict, "GetValue", [key]),
  );
  this.instructions.push(
    new MethodCallInstruction(undefined, result, "SetValue", [key, value]),
  );

  // Inner loop increment
  this.instructions.push(
    new BinaryOpInstruction(
      keyIdx,
      keyIdx,
      "+",
      createConstant(1, PrimitiveTypes.int32),
    ),
  );
  this.instructions.push(new UnconditionalJumpInstruction(innerStart));
  this.instructions.push(new LabelInstruction(innerEnd));

  // Outer loop increment
  this.instructions.push(
    new BinaryOpInstruction(
      segIdx,
      segIdx,
      "+",
      createConstant(1, PrimitiveTypes.int32),
    ),
  );
  this.instructions.push(new UnconditionalJumpInstruction(outerStart));
  this.instructions.push(new LabelInstruction(outerEnd));

  return result;
}
