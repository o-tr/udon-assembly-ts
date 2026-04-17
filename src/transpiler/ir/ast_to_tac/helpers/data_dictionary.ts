import { resolveExternSignature } from "../../../codegen/extern_signatures.js";
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
  let spreadCount = 0;
  for (const p of properties) {
    if (p.kind === "spread") spreadCount++;
  }
  if (spreadCount > 0) {
    // === ShallowClone最適化: spreadが1つだけ＆先頭にある場合 ===
    if (spreadCount === 1 && properties[0].kind === "spread") {
      const spreadValue = this.visitExpression(properties[0].value);
      const spreadType = this.getOperandType(spreadValue);

      const shallowCloneSig = resolveExternSignature(
        "DataDictionary",
        "ShallowClone",
        "method",
        [],
      );
      if (
        shallowCloneSig &&
        spreadType.udonType === ExternTypes.dataDictionary.udonType
      ) {
        // ShallowClone最適化パス
        const cloneResult = this.newTemp(ExternTypes.dataDictionary);
        this.emit(
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
          this.emit(
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
      this.emit(new CallInstruction(listResult, listCtorSig, []));
      const spreadToken = this.wrapDataToken(spreadValue);
      this.emit(
        new MethodCallInstruction(undefined, listResult, "Add", [spreadToken]),
      );
      const remaining = properties.slice(1);
      if (remaining.length > 0) {
        const dictSegment = this.emitDictionaryFromProperties(remaining);
        const dictToken = this.wrapDataToken(dictSegment);
        this.emit(
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
    this.emit(new CallInstruction(listResult, listCtorSig, []));

    let pendingProps: ObjectLiteralPropertyNode[] = [];
    const flushPending = (): void => {
      if (pendingProps.length === 0) return;
      const dictSegment = this.emitDictionaryFromProperties(pendingProps);
      const dictToken = this.wrapDataToken(dictSegment);
      this.emit(
        new MethodCallInstruction(undefined, listResult, "Add", [dictToken]),
      );
      pendingProps = [];
    };

    for (const prop of properties) {
      if (prop.kind === "spread") {
        flushPending();
        const spreadValue = this.visitExpression(prop.value);
        const spreadToken = this.wrapDataToken(spreadValue);
        this.emit(
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
  this.emit(new CallInstruction(dictResult, dictCtorSig, []));

  for (const prop of properties) {
    if (prop.kind !== "property") continue;
    const keyToken = this.wrapDataToken(
      createConstant(prop.key, PrimitiveTypes.string),
    );
    const value = this.visitExpression(prop.value);
    const valueToken = this.wrapDataToken(value);
    this.emit(
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
  this.emit(new MethodCallInstruction(result, target, "GetKeys", []));
  return result;
}

export function emitDataDictionaryValues(
  this: ASTToTACConverter,
  target: TACOperand,
): TACOperand {
  const result = this.newTemp(ExternTypes.dataList);
  this.emit(new MethodCallInstruction(result, target, "GetValues", []));
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
  this.emit(new CallInstruction(result, listCtorSig, []));

  const keysList = this.newTemp(ExternTypes.dataList);
  this.emit(new MethodCallInstruction(keysList, target, "GetKeys", []));
  const valuesList = this.newTemp(ExternTypes.dataList);
  this.emit(new MethodCallInstruction(valuesList, target, "GetValues", []));

  const indexVar = this.newTemp(PrimitiveTypes.int32);
  const lengthVar = this.newTemp(PrimitiveTypes.int32);
  this.emit(
    new AssignmentInstruction(
      indexVar,
      createConstant(0, PrimitiveTypes.int32),
    ),
  );
  this.emit(new PropertyGetInstruction(lengthVar, keysList, "Count"));

  const loopStart = this.newLabel("entries_start");
  const loopContinue = this.newLabel("entries_continue");
  const loopEnd = this.newLabel("entries_end");

  this.emit(new LabelInstruction(loopStart));
  const condTemp = this.newTemp(PrimitiveTypes.boolean);
  this.emit(new BinaryOpInstruction(condTemp, indexVar, "<", lengthVar));
  this.emit(new ConditionalJumpInstruction(condTemp, loopEnd));

  const keyTemp = this.newTemp(ObjectType);
  this.emit(
    new MethodCallInstruction(keyTemp, keysList, "get_Item", [indexVar]),
  );
  const valueTemp = this.newTemp(ObjectType);
  this.emit(
    new MethodCallInstruction(valueTemp, valuesList, "get_Item", [indexVar]),
  );

  const pairList = this.newTemp(ExternTypes.dataList);
  this.emit(new CallInstruction(pairList, listCtorSig, []));
  const keyToken = this.wrapDataToken(keyTemp);
  const valueToken = this.wrapDataToken(valueTemp);
  this.emit(new MethodCallInstruction(undefined, pairList, "Add", [keyToken]));
  this.emit(
    new MethodCallInstruction(undefined, pairList, "Add", [valueToken]),
  );

  const pairToken = this.wrapDataToken(pairList);
  this.emit(new MethodCallInstruction(undefined, result, "Add", [pairToken]));

  this.emit(new LabelInstruction(loopContinue));
  this.emit(
    new BinaryOpInstruction(
      indexVar,
      indexVar,
      "+",
      createConstant(1, PrimitiveTypes.int32),
    ),
  );
  this.emit(new UnconditionalJumpInstruction(loopStart));
  this.emit(new LabelInstruction(loopEnd));

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
  this.emit(new CallInstruction(result, dictCtorSig, []));

  // Outer loop: iterate segments DataList
  const segCount = this.newTemp(PrimitiveTypes.int32);
  this.emit(new PropertyGetInstruction(segCount, segments, "Count"));
  const segIdx = this.newTemp(PrimitiveTypes.int32);
  this.emit(
    new AssignmentInstruction(segIdx, createConstant(0, PrimitiveTypes.int32)),
  );

  const outerStart = this.newLabel("merge_outer");
  const outerEnd = this.newLabel("merge_outer_end");
  this.emit(new LabelInstruction(outerStart));
  const outerCond = this.newTemp(PrimitiveTypes.boolean);
  this.emit(new BinaryOpInstruction(outerCond, segIdx, "<", segCount));
  // ConditionalJumpInstruction = JUMP_IF_FALSE: exits loop when segIdx >= segCount
  this.emit(new ConditionalJumpInstruction(outerCond, outerEnd));

  // Get segment DataToken and unwrap to DataDictionary
  const segToken = this.newTemp(ExternTypes.dataToken);
  this.emit(
    new MethodCallInstruction(segToken, segments, "get_Item", [segIdx]),
  );
  const segDict = this.newTemp(ExternTypes.dataDictionary);
  this.emit(new PropertyGetInstruction(segDict, segToken, "DataDictionary"));

  // Inner loop: iterate keys of segment dictionary
  const keys = this.newTemp(ExternTypes.dataList);
  this.emit(new MethodCallInstruction(keys, segDict, "GetKeys", []));
  const keyCount = this.newTemp(PrimitiveTypes.int32);
  this.emit(new PropertyGetInstruction(keyCount, keys, "Count"));
  const keyIdx = this.newTemp(PrimitiveTypes.int32);
  this.emit(
    new AssignmentInstruction(keyIdx, createConstant(0, PrimitiveTypes.int32)),
  );

  const innerStart = this.newLabel("merge_inner");
  const innerEnd = this.newLabel("merge_inner_end");
  this.emit(new LabelInstruction(innerStart));
  const innerCond = this.newTemp(PrimitiveTypes.boolean);
  this.emit(new BinaryOpInstruction(innerCond, keyIdx, "<", keyCount));
  // ConditionalJumpInstruction = JUMP_IF_FALSE: exits loop when keyIdx >= keyCount
  this.emit(new ConditionalJumpInstruction(innerCond, innerEnd));

  // Copy key-value pair
  const key = this.newTemp(ExternTypes.dataToken);
  this.emit(new MethodCallInstruction(key, keys, "get_Item", [keyIdx]));
  const value = this.newTemp(ExternTypes.dataToken);
  this.emit(new MethodCallInstruction(value, segDict, "GetValue", [key]));
  this.emit(
    new MethodCallInstruction(undefined, result, "SetValue", [key, value]),
  );

  // Inner loop increment
  this.emit(
    new BinaryOpInstruction(
      keyIdx,
      keyIdx,
      "+",
      createConstant(1, PrimitiveTypes.int32),
    ),
  );
  this.emit(new UnconditionalJumpInstruction(innerStart));
  this.emit(new LabelInstruction(innerEnd));

  // Outer loop increment
  this.emit(
    new BinaryOpInstruction(
      segIdx,
      segIdx,
      "+",
      createConstant(1, PrimitiveTypes.int32),
    ),
  );
  this.emit(new UnconditionalJumpInstruction(outerStart));
  this.emit(new LabelInstruction(outerEnd));

  return result;
}
