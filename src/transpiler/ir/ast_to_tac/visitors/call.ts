import { resolveExternSignature } from "../../../codegen/extern_signatures.js";
import { computeTypeId } from "../../../codegen/type_metadata_registry.js";
import { isTsOnlyCallExpression } from "../../../frontend/ts_only.js";
import type { TypeSymbol } from "../../../frontend/type_symbols.js";
import {
  ArrayTypeSymbol,
  CollectionTypeSymbol,
  DataListTypeSymbol,
  ExternTypes,
  ObjectType,
  PrimitiveTypes,
} from "../../../frontend/type_symbols.js";
import {
  type ASTNode,
  ASTNodeKind,
  type BlockStatementNode,
  type CallExpressionNode,
  type FunctionExpressionNode,
  type IdentifierNode,
  type OptionalChainingExpressionNode,
  type PropertyAccessExpressionNode,
  UdonType,
} from "../../../frontend/types.js";
import {
  ArrayAccessInstruction,
  AssignmentInstruction,
  BinaryOpInstruction,
  CallInstruction,
  CastInstruction,
  ConditionalJumpInstruction,
  CopyInstruction,
  LabelInstruction,
  MethodCallInstruction,
  PropertyGetInstruction,
  UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import {
  type ConstantOperand,
  createConstant,
  createVariable,
  type TACOperand,
  TACOperandKind,
} from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";
import {
  isMapCollectionType,
  isSetCollectionType,
} from "../helpers/collections.js";
import { resolveTypeFromNode } from "./expression.js";

const VOID_RETURN: ConstantOperand = createConstant(null, ObjectType);

const resolveSetElementType = (
  setType: TypeSymbol | null,
  fallback?: TypeSymbol,
): TypeSymbol => {
  if (setType instanceof CollectionTypeSymbol) {
    return (
      (setType.keyType as TypeSymbol | undefined) ??
      setType.elementType ??
      fallback ??
      ObjectType
    );
  }
  return fallback ?? ObjectType;
};

const resolveMapKeyType = (
  mapType: TypeSymbol | null,
  fallback?: TypeSymbol,
): TypeSymbol => {
  if (mapType instanceof CollectionTypeSymbol) {
    return (
      (mapType.keyType as TypeSymbol | undefined) ?? fallback ?? ObjectType
    );
  }
  return fallback ?? ObjectType;
};

const resolveMapValueType = (
  mapType: TypeSymbol | null,
  fallback?: TypeSymbol,
): TypeSymbol => {
  if (mapType instanceof CollectionTypeSymbol) {
    return (
      (mapType.valueType as TypeSymbol | undefined) ?? fallback ?? ObjectType
    );
  }
  return fallback ?? ObjectType;
};

const isLiteralRadix10 = (operand: TACOperand): boolean => {
  if (operand.kind !== TACOperandKind.Constant) return false;
  const constant = operand as ConstantOperand;
  return typeof constant.value === "number" && constant.value === 10;
};

const emitSetKeysList = (
  converter: ASTToTACConverter,
  setOperand: TACOperand,
  elementType: TypeSymbol,
): TACOperand => {
  const listType = new DataListTypeSymbol(elementType);
  const listResult = converter.newTemp(listType);
  converter.instructions.push(
    new MethodCallInstruction(listResult, setOperand, "GetKeys", []),
  );
  return listResult;
};

const emitMapKeysList = (
  converter: ASTToTACConverter,
  mapOperand: TACOperand,
  keyType: TypeSymbol,
): TACOperand => {
  const listType = new DataListTypeSymbol(keyType);
  const listResult = converter.newTemp(listType);
  converter.instructions.push(
    new MethodCallInstruction(listResult, mapOperand, "GetKeys", []),
  );
  return listResult;
};

const emitMapValuesList = (
  converter: ASTToTACConverter,
  mapOperand: TACOperand,
  valueType: TypeSymbol,
): TACOperand => {
  const listType = new DataListTypeSymbol(valueType);
  const listResult = converter.newTemp(listType);
  converter.instructions.push(
    new MethodCallInstruction(listResult, mapOperand, "GetValues", []),
  );
  return listResult;
};

const emitMapEntriesList = (
  converter: ASTToTACConverter,
  mapOperand: TACOperand,
  keyType: TypeSymbol,
): TACOperand => {
  const keysList = emitMapKeysList(converter, mapOperand, keyType);
  const entriesType = new DataListTypeSymbol(ExternTypes.dataToken);
  const entriesResult = converter.newTemp(entriesType);
  const listCtorSig = converter.requireExternSignature(
    "DataList",
    "ctor",
    "method",
    [],
    "DataList",
  );
  converter.instructions.push(
    new CallInstruction(entriesResult, listCtorSig, []),
  );

  const indexVar = converter.newTemp(PrimitiveTypes.int32);
  const lengthVar = converter.newTemp(PrimitiveTypes.int32);
  converter.instructions.push(
    new AssignmentInstruction(
      indexVar,
      createConstant(0, PrimitiveTypes.int32),
    ),
  );
  converter.instructions.push(
    new PropertyGetInstruction(lengthVar, keysList, "Count"),
  );

  const loopStart = converter.newLabel("map_entries_start");
  const loopContinue = converter.newLabel("map_entries_continue");
  const loopEnd = converter.newLabel("map_entries_end");

  converter.instructions.push(new LabelInstruction(loopStart));
  const condTemp = converter.newTemp(PrimitiveTypes.boolean);
  converter.instructions.push(
    new BinaryOpInstruction(condTemp, indexVar, "<", lengthVar),
  );
  converter.instructions.push(
    new ConditionalJumpInstruction(condTemp, loopEnd),
  );

  const keyToken = converter.newTemp(ExternTypes.dataToken);
  converter.instructions.push(
    new MethodCallInstruction(keyToken, keysList, "get_Item", [indexVar]),
  );
  const valueToken = converter.newTemp(ExternTypes.dataToken);
  converter.instructions.push(
    new MethodCallInstruction(valueToken, mapOperand, "GetValue", [keyToken]),
  );

  const pairList = converter.newTemp(
    new DataListTypeSymbol(ExternTypes.dataToken),
  );
  converter.instructions.push(new CallInstruction(pairList, listCtorSig, []));
  converter.instructions.push(
    new MethodCallInstruction(undefined, pairList, "Add", [keyToken]),
  );
  converter.instructions.push(
    new MethodCallInstruction(undefined, pairList, "Add", [valueToken]),
  );
  const pairToken = converter.wrapDataToken(pairList);
  converter.instructions.push(
    new MethodCallInstruction(undefined, entriesResult, "Add", [pairToken]),
  );

  converter.instructions.push(new LabelInstruction(loopContinue));
  converter.instructions.push(
    new BinaryOpInstruction(
      indexVar,
      indexVar,
      "+",
      createConstant(1, PrimitiveTypes.int32),
    ),
  );
  converter.instructions.push(new UnconditionalJumpInstruction(loopStart));
  converter.instructions.push(new LabelInstruction(loopEnd));

  return entriesResult;
};

export function visitCallExpression(
  this: ASTToTACConverter,
  node: CallExpressionNode,
): TACOperand {
  const callee = node.callee;
  const rawArgs = node.arguments;
  if (isTsOnlyCallExpression(node)) {
    return createConstant(null, ObjectType);
  }
  const defaultResult = () => this.newTemp(ObjectType);

  // super() constructor calls are handled by the class constructor visitor;
  // if one reaches here, treat it as void (matching VOID_RETURN semantics).
  if (callee.kind === ASTNodeKind.SuperExpression) {
    return VOID_RETURN;
  }

  if (callee.kind === ASTNodeKind.Identifier) {
    const calleeName = (callee as IdentifierNode).name;
    if (calleeName === "setImmediate") {
      if (rawArgs.length < 1) {
        throw new Error("setImmediate expects a callback argument.");
      }
      const callbackNode = rawArgs[0];
      // Instead of executing the callback inline, schedule it for one frame
      // later via SendCustomEventDelayedFrames. For simplicity only allow
      // callbacks that are a single call of the form `this.someMethod()`
      // (optionally wrapped in a block). Other cases will throw.
      if (callbackNode.kind !== ASTNodeKind.FunctionExpression) {
        throw new Error(
          "setImmediate currently requires an inline function or arrow callback.",
        );
      }
      const callback = callbackNode as FunctionExpressionNode;

      // Extract the inner call expression
      let innerCall: CallExpressionNode | null = null;
      if (callback.body.kind === ASTNodeKind.BlockStatement) {
        const block = callback.body as BlockStatementNode;
        if (block.statements.length !== 1) {
          throw new Error(
            "setImmediate callback must contain exactly one statement when using delayed scheduling",
          );
        }
        const stmt = block.statements[0];
        if (stmt.kind === ASTNodeKind.CallExpression) {
          innerCall = stmt as CallExpressionNode;
        }
      } else if (callback.body.kind === ASTNodeKind.CallExpression) {
        innerCall = callback.body as CallExpressionNode;
      }

      if (!innerCall) {
        throw new Error(
          "setImmediate callback must be a single call expression to schedule",
        );
      }

      // Only allow calls of the form `this.methodName(...)` with no args
      const calleeExpr = innerCall.callee;
      if (calleeExpr.kind !== ASTNodeKind.PropertyAccessExpression) {
        throw new Error(
          "setImmediate delayed scheduling only supports `this.method()` style callbacks",
        );
      }
      const propAccess = calleeExpr as PropertyAccessExpressionNode;
      if (propAccess.object.kind !== ASTNodeKind.ThisExpression) {
        throw new Error(
          "setImmediate delayed scheduling only supports `this.method()` style callbacks",
        );
      }
      if (innerCall.arguments.length !== 0) {
        throw new Error(
          "setImmediate delayed scheduling only supports zero-argument callbacks. " +
            "Move arguments into class fields and read them in the target method instead.",
        );
      }

      const methodName = propAccess.property;
      const classLayout = this.currentClassName
        ? this.getUdonBehaviourLayout(this.currentClassName)
        : null;
      const methodLayout = classLayout?.get(methodName) ?? null;
      const exportName = methodLayout?.exportMethodName ?? methodName;

      const methodNameConst = createConstant(exportName, PrimitiveTypes.string);
      const delayConst = createConstant(1, PrimitiveTypes.int32);
      const externSig = this.requireExternSignature(
        "UdonBehaviour",
        "SendCustomEventDelayedFrames",
        "method",
        ["string", "int"],
        "void",
      );

      // call on `this` (use the real `this` operand so SendCustomEventDelayedFrames
      // is invoked on the behaviour instance)
      const classType = this.currentClassName
        ? this.typeMapper.mapTypeScriptType(this.currentClassName)
        : ObjectType;
      const thisOperand = createVariable("this", classType);
      this.instructions.push(
        new CallInstruction(undefined, externSig, [
          thisOperand,
          methodNameConst,
          delayConst,
        ]),
      );
      // No meaningful return value from scheduling; represent as `null` object
      return createConstant(null, ObjectType);
    }
    if (node.isNew && calleeName === "Set") {
      return emitSetConstructor(this, node);
    }
    if (node.isNew && calleeName === "Map") {
      return emitMapConstructor(this, node);
    }
  }

  let args: TACOperand[] | null = null;
  const getArgs = (): TACOperand[] => {
    if (!args) {
      args = rawArgs.map((arg) => this.visitExpression(arg));
    }
    return args;
  };
  if (callee.kind === ASTNodeKind.Identifier) {
    const calleeName = (callee as IdentifierNode).name;
    const symbol = this.symbolTable.lookup(calleeName);
    const initialValue = symbol?.initialValue as ASTNode | undefined;
    if (initialValue?.kind === ASTNodeKind.PropertyAccessExpression) {
      const access = initialValue as PropertyAccessExpressionNode;
      if (access.object.kind === ASTNodeKind.Identifier) {
        const objectName = (access.object as IdentifierNode).name;
        const evaluatedArgs = getArgs();
        if (objectName === "UdonTypeConverters") {
          if (evaluatedArgs.length !== 1) {
            throw new Error(
              `UdonTypeConverters.${access.property} expects 1 argument`,
            );
          }
          const targetType = this.getUdonTypeConverterTargetType(
            access.property,
          );
          if (!targetType) {
            throw new Error(
              `Unsupported UdonTypeConverters method: ${access.property}`,
            );
          }
          const castResult = this.newTemp(targetType);
          this.instructions.push(
            new CastInstruction(castResult, evaluatedArgs[0]),
          );
          return castResult;
        }
        const inlineResult = this.visitInlineStaticMethodCall(
          objectName,
          access.property,
          evaluatedArgs,
        );
        if (inlineResult) return inlineResult;
        const externSig = this.resolveStaticExtern(
          objectName,
          access.property,
          "method",
        );
        if (externSig) {
          const returnType = resolveExternReturnType(externSig) ?? ObjectType;
          if (returnType === PrimitiveTypes.void) {
            this.instructions.push(
              new CallInstruction(undefined, externSig, evaluatedArgs),
            );
            return VOID_RETURN;
          }
          const callResult = this.newTemp(returnType);
          this.instructions.push(
            new CallInstruction(callResult, externSig, evaluatedArgs),
          );
          return callResult;
        }
      }
    }
    if (calleeName === "Error") {
      const evaluatedArgs = getArgs();
      return evaluatedArgs[0] ?? createConstant("Error", PrimitiveTypes.string);
    }
    if (calleeName === "BigInt") {
      const evaluatedArgs = getArgs();
      if (evaluatedArgs.length !== 1) {
        throw new Error("BigInt(...) expects one argument.");
      }
      const arg = evaluatedArgs[0] ?? createConstant(0, PrimitiveTypes.single);
      const argType = this.getOperandType(arg);
      if (
        argType.udonType === UdonType.Int64 ||
        argType.udonType === UdonType.UInt64
      ) {
        return arg;
      }
      const castResult = this.newTemp(PrimitiveTypes.int64);
      this.instructions.push(new CastInstruction(castResult, arg));
      return castResult;
    }
    if (calleeName === "Number") {
      const evaluatedArgs = getArgs();
      if (evaluatedArgs.length === 0) {
        return createConstant(0, PrimitiveTypes.single);
      }
      if (evaluatedArgs.length !== 1) {
        throw new Error("Number(...) expects one argument.");
      }
      const arg = evaluatedArgs[0];
      const argType = this.getOperandType(arg);
      // Udon only supports Single (float32), not 64-bit double.
      // Integer values > 2^24 will lose precision — this is an Udon
      // platform limitation, not a transpiler bug.
      if (argType.udonType === UdonType.Single) {
        return arg;
      }
      const castResult = this.newTemp(PrimitiveTypes.single);
      this.instructions.push(new CastInstruction(castResult, arg));
      return castResult;
    }
    if (calleeName === "parseInt") {
      const evaluatedArgs = getArgs();
      if (evaluatedArgs.length === 0) {
        // No-arg parseInt: return a consistent int32 result (0).
        // Full JS semantics (NaN) are not representable as int32; choose a
        // consistent sentinel of 0 to keep the return type stable.
        return createConstant(0, PrimitiveTypes.int32);
      }
      if (evaluatedArgs.length > 2) {
        throw new Error("parseInt(...) expects one or two arguments.");
      }
      if (evaluatedArgs.length === 2) {
        const radix = evaluatedArgs[1];
        if (!isLiteralRadix10(radix)) {
          // Radix-aware parseInt not implemented in transpiler.
          throw new Error(
            "parseInt with radix is not supported by the transpiler",
          );
        }
      }
      const arg = evaluatedArgs[0];
      // Int32.Parse is stricter than JS parseInt (e.g., throws on "3.14",
      // "0xFF", whitespace). This intentionally diverges from JS semantics.
      // Use Int32.Parse extern for string->int conversion when possible.
      const result = this.newTemp(PrimitiveTypes.int32);
      const externSig = this.requireExternSignature(
        "Int32",
        "Parse",
        "method",
        ["string"],
        "int",
      );
      this.instructions.push(new CallInstruction(result, externSig, [arg]));
      return result;
    }
    if (calleeName === "parseFloat") {
      const evaluatedArgs = getArgs();
      if (evaluatedArgs.length === 0) {
        // No-arg parseFloat -> NaN
        return createConstant(NaN, PrimitiveTypes.single);
      }
      if (evaluatedArgs.length !== 1) {
        throw new Error("parseFloat(...) expects one argument.");
      }
      const arg = evaluatedArgs[0];
      // Use Single.Parse extern for string->float conversion, mirroring
      // how parseInt uses Int32.Parse.
      const result = this.newTemp(PrimitiveTypes.single);
      const externSig = this.requireExternSignature(
        "Single",
        "Parse",
        "method",
        ["string"],
        "float",
      );
      this.instructions.push(new CallInstruction(result, externSig, [arg]));
      return result;
    }
    if (node.isNew) {
      const canInline =
        (this.classMap.has(calleeName) ||
          this.classRegistry?.getClass(calleeName)) &&
        !this.classRegistry?.isStub(calleeName) &&
        !this.udonBehaviourClasses.has(calleeName);
      if (canInline) {
        return this.visitInlineConstructor(calleeName, getArgs());
      }
    }
    if (
      node.isNew &&
      (calleeName === "UdonList" ||
        calleeName === "UdonDictionary" ||
        calleeName === "UdonQueue" ||
        calleeName === "UdonStack" ||
        calleeName === "UdonHashSet")
    ) {
      const typeArgText = node.typeArguments?.length
        ? `${calleeName}<${node.typeArguments.join(", ")}>`
        : calleeName;
      const collectionType = this.typeMapper.mapTypeScriptType(typeArgText);
      const collectionResult = this.newTemp(collectionType);
      const evaluatedArgs = getArgs();
      const paramTypes = evaluatedArgs.map(
        (arg) => this.getOperandType(arg).name,
      );
      const externSig = this.requireExternSignature(
        calleeName,
        "ctor",
        "method",
        paramTypes,
        calleeName,
      );
      this.instructions.push(
        new CallInstruction(collectionResult, externSig, evaluatedArgs),
      );
      return collectionResult;
    }
    if (node.isNew && calleeName === "DataList") {
      const listResult = this.newTemp(ExternTypes.dataList);
      const externSig = this.requireExternSignature(
        "DataList",
        "ctor",
        "method",
        [],
        "DataList",
      );
      this.instructions.push(new CallInstruction(listResult, externSig, []));
      return listResult;
    }
    if (node.isNew && calleeName === "DataDictionary") {
      const dictResult = this.newTemp(ExternTypes.dataDictionary);
      const externSig = this.requireExternSignature(
        "DataDictionary",
        "ctor",
        "method",
        [],
        "DataDictionary",
      );
      this.instructions.push(new CallInstruction(dictResult, externSig, []));
      return dictResult;
    }
    if (calleeName === "Array") {
      const evaluatedArgs = getArgs();
      const arrayType = node.typeArguments?.[0]
        ? this.typeMapper.mapTypeScriptType(node.typeArguments[0])
        : ObjectType;
      const listResult = this.newTemp(new DataListTypeSymbol(arrayType));
      const externSig = this.requireExternSignature(
        "DataList",
        "ctor",
        "method",
        [],
        "DataList",
      );
      this.instructions.push(new CallInstruction(listResult, externSig, []));
      // Single-argument numeric-length semantics: Array(n) and new Array(n)
      // are equivalent in JS and both produce a length-n array.
      if (rawArgs.length === 1) {
        const argOperand = evaluatedArgs[0];
        const argType = this.getOperandType(argOperand);
        const isNumericLength =
          argType.udonType === UdonType.Int16 ||
          argType.udonType === UdonType.UInt16 ||
          argType.udonType === UdonType.Int32 ||
          argType.udonType === UdonType.UInt32 ||
          argType.udonType === UdonType.Int64 ||
          argType.udonType === UdonType.UInt64 ||
          argType.udonType === UdonType.Byte ||
          argType.udonType === UdonType.SByte;

        const isConstantIntegerLength =
          argOperand.kind === TACOperandKind.Constant &&
          (argType.udonType === UdonType.Single ||
            argType.udonType === UdonType.Double) &&
          typeof (argOperand as ConstantOperand).value === "number" &&
          Number.isInteger((argOperand as ConstantOperand).value);

        const isFloatType =
          argType.udonType === UdonType.Single ||
          argType.udonType === UdonType.Double;
        const isNonConstFloat =
          isFloatType && argOperand.kind !== TACOperandKind.Constant;

        // For non-constant floats we can't decide statically whether the
        // runtime value will be an integer. Generate a runtime check:
        // if (floor(arg) == arg) -> treat as numeric length, else treat as single element.
        if (isNonConstFloat) {
          const floorValue = this.visitMathStaticCall("floor", [argOperand]);
          if (!floorValue) {
            // If Math.floor isn't available for some reason, fall back to
            // treating the argument as a single element.
            const token = this.wrapDataToken(argOperand);
            this.instructions.push(
              new MethodCallInstruction(undefined, listResult, "Add", [token]),
            );
            return listResult;
          }

          const isIntTemp = this.newTemp(PrimitiveTypes.boolean);
          this.instructions.push(
            new BinaryOpInstruction(isIntTemp, argOperand, "==", floorValue),
          );

          const nonIntLabel = this.newLabel("array_non_int_length");
          const doneLabel = this.newLabel("array_length_done");

          // ConditionalJumpInstruction(condition, label) emits `ifFalse condition goto label`.
          // If `isIntTemp` is false (non-integer), jump to `nonIntLabel` to add the element.
          this.instructions.push(
            new ConditionalJumpInstruction(isIntTemp, nonIntLabel),
          );

          // Integer-case: do nothing (create empty list), jump to done.
          this.instructions.push(new UnconditionalJumpInstruction(doneLabel));

          // Non-integer case: add the single value as element.
          this.instructions.push(new LabelInstruction(nonIntLabel));
          const token = this.wrapDataToken(argOperand);
          this.instructions.push(
            new MethodCallInstruction(undefined, listResult, "Add", [token]),
          );
          this.instructions.push(new LabelInstruction(doneLabel));

          return listResult;
        }

        if (!isNumericLength && !isConstantIntegerLength) {
          const token = this.wrapDataToken(argOperand);
          this.instructions.push(
            new MethodCallInstruction(undefined, listResult, "Add", [token]),
          );
        }
        return listResult;
      }
      for (const arg of evaluatedArgs) {
        const token = this.wrapDataToken(arg);
        this.instructions.push(
          new MethodCallInstruction(undefined, listResult, "Add", [token]),
        );
      }
      return listResult;
    }
    if (
      (calleeName === "Instantiate" || calleeName === "VRCInstantiate") &&
      getArgs().length === 1
    ) {
      const instResult = this.newTemp(ExternTypes.gameObject);
      const externSig = this.requireExternSignature(
        "VRCInstantiate",
        "Instantiate",
        "method",
        ["GameObject"],
        "GameObject",
      );
      this.instructions.push(
        new CallInstruction(instResult, externSig, getArgs()),
      );
      return instResult;
    }
    if (node.isNew && (calleeName === "Vector3" || calleeName === "Color")) {
      const externSig = `__ctor_${calleeName}`;
      const ctorType = this.typeMapper.mapTypeScriptType(calleeName);
      const ctorResult = this.newTemp(ctorType);
      this.instructions.push(
        new CallInstruction(ctorResult, externSig, getArgs()),
      );
      return ctorResult;
    }
    const callResult = defaultResult();
    this.instructions.push(
      new CallInstruction(callResult, calleeName, getArgs()),
    );
    return callResult;
  }

  if (callee.kind === ASTNodeKind.PropertyAccessExpression) {
    const propAccess = callee as PropertyAccessExpressionNode;
    const object = this.visitExpression(propAccess.object);
    const objectType = this.getOperandType(object);
    const resolvedType = resolveTypeFromNode(this, propAccess.object);
    const setType = isSetCollectionType(objectType)
      ? objectType
      : isSetCollectionType(resolvedType)
        ? resolvedType
        : null;
    const mapType = isMapCollectionType(objectType)
      ? objectType
      : isMapCollectionType(resolvedType)
        ? resolvedType
        : null;
    if (setType) {
      const setResult = visitSetMethodCall(
        this,
        object,
        setType,
        propAccess,
        rawArgs,
      );
      if (setResult) {
        return setResult;
      }
    }
    if (mapType) {
      const mapResult = visitMapMethodCall(
        this,
        object,
        mapType,
        propAccess,
        rawArgs,
      );
      if (mapResult) {
        return mapResult;
      }
    }

    const evaluatedArgs = getArgs();

    if (
      propAccess.object.kind === ASTNodeKind.Identifier &&
      (propAccess.object as IdentifierNode).name === "UdonTypeConverters"
    ) {
      if (evaluatedArgs.length !== 1) {
        throw new Error(
          `UdonTypeConverters.${propAccess.property} expects 1 argument`,
        );
      }
      const targetType = this.getUdonTypeConverterTargetType(
        propAccess.property,
      );
      if (!targetType) {
        throw new Error(
          `Unsupported UdonTypeConverters method: ${propAccess.property}`,
        );
      }
      const castResult = this.newTemp(targetType);
      this.instructions.push(new CastInstruction(castResult, evaluatedArgs[0]));
      return castResult;
    }

    if (
      propAccess.object.kind === ASTNodeKind.Identifier &&
      (propAccess.object as IdentifierNode).name === "BigInt"
    ) {
      if (propAccess.property === "asUintN") {
        if (evaluatedArgs.length !== 2) {
          throw new Error("BigInt.asUintN expects two arguments.");
        }
        return evaluatedArgs[1] ?? createConstant(0, PrimitiveTypes.single);
      }
    }

    if (
      propAccess.object.kind === ASTNodeKind.Identifier &&
      (propAccess.object as IdentifierNode).name === "Object"
    ) {
      const objectResult = this.visitObjectStaticCall(
        propAccess.property,
        evaluatedArgs,
      );
      if (objectResult != null) return objectResult;
    }

    if (
      propAccess.object.kind === ASTNodeKind.Identifier &&
      (propAccess.object as IdentifierNode).name === "Number"
    ) {
      const numberResult = this.visitNumberStaticCall(
        propAccess.property,
        evaluatedArgs,
      );
      if (numberResult != null) return numberResult;
    }

    if (
      propAccess.object.kind === ASTNodeKind.Identifier &&
      (propAccess.object as IdentifierNode).name === "Math"
    ) {
      const mathResult = this.visitMathStaticCall(
        propAccess.property,
        evaluatedArgs,
      );
      if (mathResult != null) return mathResult;
    }

    if (
      propAccess.object.kind === ASTNodeKind.Identifier &&
      (propAccess.object as IdentifierNode).name === "Array"
    ) {
      const arrayResult = this.visitArrayStaticCall(
        propAccess.property,
        evaluatedArgs,
      );
      if (arrayResult != null) return arrayResult;
    }

    if (
      propAccess.object.kind === ASTNodeKind.Identifier &&
      (propAccess.object as IdentifierNode).name === "Date" &&
      propAccess.property === "now"
    ) {
      return createConstant(0, PrimitiveTypes.single);
    }

    if (
      propAccess.object.kind === ASTNodeKind.Identifier &&
      (propAccess.object as IdentifierNode).name === "JSON"
    ) {
      if (propAccess.property === "stringify") {
        return createConstant("{}", PrimitiveTypes.string);
      }
      if (propAccess.property === "parse") {
        return createConstant(null, ObjectType);
      }
    }

    if (propAccess.object.kind === ASTNodeKind.Identifier) {
      const className = (propAccess.object as IdentifierNode).name;
      const inlineResult = this.visitInlineStaticMethodCall(
        className,
        propAccess.property,
        evaluatedArgs,
      );
      if (inlineResult != null) return inlineResult;
    }

    if (propAccess.object.kind === ASTNodeKind.Identifier) {
      const externSig = this.resolveStaticExtern(
        (propAccess.object as IdentifierNode).name,
        propAccess.property,
        "method",
      );
      if (externSig) {
        const returnType = resolveExternReturnType(externSig) ?? ObjectType;
        if (returnType === PrimitiveTypes.void) {
          this.instructions.push(
            new CallInstruction(undefined, externSig, evaluatedArgs),
          );
          return VOID_RETURN;
        }
        const callResult = this.newTemp(returnType);
        this.instructions.push(
          new CallInstruction(callResult, externSig, evaluatedArgs),
        );
        return callResult;
      }
    }

    // Handle console.log/error/warn
    if (
      propAccess.object.kind === ASTNodeKind.Identifier &&
      (propAccess.object as IdentifierNode).name === "console"
    ) {
      let externName = "";
      switch (propAccess.property) {
        case "log":
        case "info":
          externName = this.requireExternSignature(
            "Debug",
            "Log",
            "method",
            ["object"],
            "void",
          );
          break;
        case "error":
          externName = this.requireExternSignature(
            "Debug",
            "LogError",
            "method",
            ["object"],
            "void",
          );
          break;
        case "warn":
          externName = this.requireExternSignature(
            "Debug",
            "LogWarning",
            "method",
            ["object"],
            "void",
          );
          break;
      }

      if (externName) {
        this.instructions.push(
          new CallInstruction(undefined, externName, evaluatedArgs),
        );
        return VOID_RETURN; // Console methods return void
      }
    }

    if (
      propAccess.property === "length" &&
      propAccess.object.kind === ASTNodeKind.Identifier
    ) {
      const lengthResult = this.newTemp(PrimitiveTypes.int32);
      const arrayType = this.getOperandType(object);
      const lengthProp =
        arrayType.name === ExternTypes.dataList.name ? "Count" : "length";
      this.instructions.push(
        new PropertyGetInstruction(lengthResult, object, lengthProp),
      );
      return lengthResult;
    }

    if (
      propAccess.property === "GetComponent" &&
      node.typeArguments?.length === 1
    ) {
      const targetType = node.typeArguments[0] ?? "object";
      const targetTypeSymbol = this.typeMapper.mapTypeScriptType(targetType);
      const typeId = computeTypeId(targetType);
      const typeOperand = createConstant(
        `0x${typeId.toString(16)}`,
        PrimitiveTypes.int64,
      );
      const externSig = this.requireExternSignature(
        "GetComponentShim",
        "GetComponent",
        "method",
        ["Component", "UdonLong"],
        "Component",
      );
      const typeResult = this.newTemp(targetTypeSymbol);
      this.instructions.push(
        new CallInstruction(typeResult, externSig, [object, typeOperand]),
      );
      return typeResult;
    }
    if (
      propAccess.property === "SendCustomEvent" &&
      evaluatedArgs.length === 1 &&
      evaluatedArgs[0].kind === TACOperandKind.Constant
    ) {
      const _methodName = (evaluatedArgs[0] as ConstantOperand).value as string;
      const externSig = this.requireExternSignature(
        "UdonBehaviour",
        "SendCustomEvent",
        "method",
        ["string"],
        "void",
      );
      this.instructions.push(
        new CallInstruction(undefined, externSig, [object, evaluatedArgs[0]]),
      );
      return VOID_RETURN;
    }
    if (
      propAccess.property === "SendCustomNetworkEvent" &&
      evaluatedArgs.length === 2
    ) {
      const externSig = this.requireExternSignature(
        "UdonBehaviour",
        "SendCustomNetworkEvent",
        "method",
        ["NetworkEventTarget", "string"],
        "void",
      );
      this.instructions.push(
        new CallInstruction(undefined, externSig, [
          object,
          evaluatedArgs[0],
          evaluatedArgs[1],
        ]),
      );
      return VOID_RETURN;
    }
    if (
      this.isUdonBehaviourType(objectType) &&
      propAccess.object.kind !== ASTNodeKind.ThisExpression
    ) {
      const layout = this.getUdonBehaviourLayout(objectType.name)?.get(
        propAccess.property,
      );
      const methodName = createConstant(
        layout?.exportMethodName ?? propAccess.property,
        PrimitiveTypes.string,
      );
      if (layout) {
        const paramCount = Math.min(
          evaluatedArgs.length,
          layout.parameterExportNames.length,
        );
        for (let i = 0; i < paramCount; i++) {
          const paramName = createConstant(
            layout.parameterExportNames[i],
            PrimitiveTypes.string,
          );
          const externSig = this.requireExternSignature(
            "UdonBehaviour",
            "SetProgramVariable",
            "method",
            ["string", "object"],
            "void",
          );
          this.instructions.push(
            new CallInstruction(undefined, externSig, [
              object,
              paramName,
              evaluatedArgs[i],
            ]),
          );
        }
      }
      const sendExtern = this.requireExternSignature(
        "UdonBehaviour",
        "SendCustomEvent",
        "method",
        ["string"],
        "void",
      );
      this.instructions.push(
        new CallInstruction(undefined, sendExtern, [object, methodName]),
      );

      if (layout?.returnExportName) {
        const getExtern = this.requireExternSignature(
          "UdonBehaviour",
          "GetProgramVariable",
          "method",
          ["string"],
          "object",
        );
        const returnName = createConstant(
          layout.returnExportName,
          PrimitiveTypes.string,
        );
        const returnTemp = this.newTemp(layout.returnType);
        this.instructions.push(
          new CallInstruction(returnTemp, getExtern, [object, returnName]),
        );
        return returnTemp;
      }

      return VOID_RETURN;
    }
    if (objectType.name === ExternTypes.dataList.name) {
      if (propAccess.property === "Add" && evaluatedArgs.length === 1) {
        const token = this.wrapDataToken(evaluatedArgs[0]);
        this.instructions.push(
          new MethodCallInstruction(undefined, object, "Add", [token]),
        );
        return VOID_RETURN;
      }
      if (propAccess.property === "Remove" && evaluatedArgs.length === 1) {
        const token = this.wrapDataToken(evaluatedArgs[0]);
        const removeResult = this.newTemp(PrimitiveTypes.boolean);
        this.instructions.push(
          new MethodCallInstruction(removeResult, object, "Remove", [token]),
        );
        return removeResult;
      }
    }
    if (objectType.name === ExternTypes.dataDictionary.name) {
      if (propAccess.property === "SetValue" && evaluatedArgs.length === 2) {
        const keyToken = this.wrapDataToken(evaluatedArgs[0]);
        const valueToken = this.wrapDataToken(evaluatedArgs[1]);
        this.instructions.push(
          new MethodCallInstruction(undefined, object, "SetValue", [
            keyToken,
            valueToken,
          ]),
        );
        return VOID_RETURN;
      }
      if (
        (propAccess.property === "ContainsKey" ||
          propAccess.property === "Remove") &&
        evaluatedArgs.length === 1
      ) {
        const keyToken = this.wrapDataToken(evaluatedArgs[0]);
        const dictResult = this.newTemp(PrimitiveTypes.boolean);
        this.instructions.push(
          new MethodCallInstruction(dictResult, object, propAccess.property, [
            keyToken,
          ]),
        );
        return dictResult;
      }
    }
    if (objectType.udonType === UdonType.Array) {
      const arrayReturn =
        objectType instanceof ArrayTypeSymbol
          ? objectType
          : new ArrayTypeSymbol(ObjectType);
      switch (propAccess.property) {
        case "slice":
        case "concat":
        case "filter":
        case "reverse":
        case "sort": {
          const result = this.newTemp(arrayReturn);
          this.instructions.push(
            new MethodCallInstruction(
              result,
              object,
              propAccess.property,
              evaluatedArgs,
            ),
          );
          return result;
        }
        case "map": {
          const result = this.newTemp(new ArrayTypeSymbol(ObjectType));
          this.instructions.push(
            new MethodCallInstruction(result, object, "map", evaluatedArgs),
          );
          return result;
        }
        case "find": {
          const elementType =
            objectType instanceof ArrayTypeSymbol
              ? objectType.elementType
              : ObjectType;
          const result = this.newTemp(elementType);
          this.instructions.push(
            new MethodCallInstruction(result, object, "find", evaluatedArgs),
          );
          return result;
        }
        case "indexOf": {
          const result = this.newTemp(PrimitiveTypes.int32);
          this.instructions.push(
            new MethodCallInstruction(result, object, "indexOf", evaluatedArgs),
          );
          return result;
        }
        case "includes": {
          const result = this.newTemp(PrimitiveTypes.boolean);
          this.instructions.push(
            new MethodCallInstruction(
              result,
              object,
              "includes",
              evaluatedArgs,
            ),
          );
          return result;
        }
        case "join": {
          const result = this.newTemp(PrimitiveTypes.string);
          this.instructions.push(
            new MethodCallInstruction(result, object, "join", evaluatedArgs),
          );
          return result;
        }
      }
    }
    if (
      propAccess.property === "RequestSerialization" &&
      evaluatedArgs.length === 0
    ) {
      const externSig = this.requireExternSignature(
        "UdonBehaviour",
        "RequestSerialization",
        "method",
        [],
        "void",
      );
      this.instructions.push(
        new CallInstruction(undefined, externSig, [object]),
      );
      return VOID_RETURN;
    }
    let resolvedReturnType: TypeSymbol | null = null;
    if (this.classRegistry) {
      const classMeta = this.classRegistry.getClass(objectType.name);
      if (classMeta) {
        const method = this.classRegistry
          .getMergedMethods(objectType.name)
          .find((candidate) => candidate.name === propAccess.property);
        if (method) {
          resolvedReturnType = this.typeMapper.mapTypeScriptType(
            method.returnType,
          );
        }
      } else {
        const interfaceMeta = this.classRegistry.getInterface(objectType.name);
        const method = interfaceMeta?.methods.find(
          (candidate) => candidate.name === propAccess.property,
        );
        if (method) {
          resolvedReturnType = this.typeMapper.mapTypeScriptType(
            method.returnType,
          );
        }
      }
    }

    if (resolvedReturnType === PrimitiveTypes.void) {
      this.instructions.push(
        new MethodCallInstruction(
          undefined,
          object,
          propAccess.property,
          evaluatedArgs,
        ),
      );
      return VOID_RETURN;
    }

    const callResult = this.newTemp(resolvedReturnType ?? ObjectType);
    this.instructions.push(
      new MethodCallInstruction(
        callResult,
        object,
        propAccess.property,
        evaluatedArgs,
      ),
    );
    return callResult;
  }

  if (callee.kind === ASTNodeKind.OptionalChainingExpression) {
    const opt = callee as OptionalChainingExpressionNode;
    const evaluatedArgs = getArgs();
    const object = this.visitExpression(opt.object);
    const objTemp = this.newTemp(this.getOperandType(object));
    this.instructions.push(new CopyInstruction(objTemp, object));

    const isNotNull = this.newTemp(PrimitiveTypes.boolean);
    this.instructions.push(
      new BinaryOpInstruction(
        isNotNull,
        objTemp,
        "!=",
        createConstant(null, ObjectType),
      ),
    );
    const nullLabel = this.newLabel("opt_call_null");
    const endLabel = this.newLabel("opt_call_end");
    const callResult = this.newTemp(ObjectType);
    // ConditionalJumpInstruction(condition, label) emits `ifFalse condition goto label`.
    // If `isNotNull` is false (object is null), jump to `nullLabel` to set the result to null.
    this.instructions.push(
      new ConditionalJumpInstruction(isNotNull, nullLabel),
    );

    this.instructions.push(
      new MethodCallInstruction(
        callResult,
        objTemp,
        opt.property,
        evaluatedArgs,
      ),
    );
    this.instructions.push(new UnconditionalJumpInstruction(endLabel));

    this.instructions.push(new LabelInstruction(nullLabel));
    this.instructions.push(
      new AssignmentInstruction(callResult, createConstant(null, ObjectType)),
    );
    this.instructions.push(new LabelInstruction(endLabel));
    return callResult;
  }

  throw new Error(`Unsupported call target kind: ${callee.kind}`);
}

function emitSetConstructor(
  converter: ASTToTACConverter,
  node: CallExpressionNode,
): TACOperand {
  const typeArgText = node.typeArguments?.length
    ? `Set<${node.typeArguments.join(", ")}>`
    : "Set";
  const setType = converter.typeMapper.mapTypeScriptType(typeArgText);
  const setResult = converter.newTemp(setType);
  const ctorSig = converter.requireExternSignature(
    "DataDictionary",
    "ctor",
    "method",
    [],
    "DataDictionary",
  );
  converter.instructions.push(new CallInstruction(setResult, ctorSig, []));

  if (node.arguments.length > 0) {
    if (node.arguments.length !== 1) {
      throw new Error("Set constructor expects at most one iterable argument.");
    }
    const iterableNode = node.arguments[0];
    const iterableOperand = converter.visitExpression(iterableNode);
    emitSetPopulateFromIterable(
      converter,
      setResult,
      setType,
      iterableNode,
      iterableOperand,
    );
  }

  return setResult;
}

function emitSetPopulateFromIterable(
  converter: ASTToTACConverter,
  setOperand: TACOperand,
  setType: TypeSymbol,
  iterableNode: ASTNode,
  iterableOperand: TACOperand,
): void {
  const resolvedIterableType = resolveTypeFromNode(converter, iterableNode);
  const operandType = converter.getOperandType(iterableOperand);
  let elementType = resolveSetElementType(setType);

  let listOperand = iterableOperand;
  let isDataList = false;

  const isArrayType =
    operandType instanceof ArrayTypeSymbol ||
    operandType.udonType === UdonType.Array ||
    resolvedIterableType instanceof ArrayTypeSymbol ||
    resolvedIterableType?.udonType === UdonType.Array;

  const isDataListType =
    operandType instanceof DataListTypeSymbol ||
    operandType.name === ExternTypes.dataList.name ||
    operandType.udonType === UdonType.DataList ||
    resolvedIterableType instanceof DataListTypeSymbol ||
    resolvedIterableType?.name === ExternTypes.dataList.name ||
    resolvedIterableType?.udonType === UdonType.DataList;

  const isDictionaryType =
    (operandType === ExternTypes.dataDictionary ||
      operandType.name === ExternTypes.dataDictionary.name ||
      operandType.udonType === UdonType.DataDictionary ||
      resolvedIterableType === ExternTypes.dataDictionary ||
      resolvedIterableType?.name === ExternTypes.dataDictionary.name ||
      resolvedIterableType?.udonType === UdonType.DataDictionary) &&
    !isMapCollectionType(operandType) &&
    !isMapCollectionType(resolvedIterableType);

  if (elementType === ObjectType) {
    if (resolvedIterableType instanceof ArrayTypeSymbol) {
      elementType = resolvedIterableType.elementType;
    } else if (resolvedIterableType instanceof DataListTypeSymbol) {
      elementType = resolvedIterableType.elementType;
    }
  }

  if (isArrayType) {
    // Array iterable, keep listOperand as-is.
  } else if (isDictionaryType) {
    listOperand = emitSetKeysList(converter, iterableOperand, elementType);
    isDataList = true;
  } else if (isDataListType) {
    isDataList = true;
  } else {
    throw new Error(
      "Set constructor expects an Array, DataList, or Set iterable.",
    );
  }

  const indexVar = converter.newTemp(PrimitiveTypes.int32);
  const lengthVar = converter.newTemp(PrimitiveTypes.int32);
  converter.instructions.push(
    new AssignmentInstruction(
      indexVar,
      createConstant(0, PrimitiveTypes.int32),
    ),
  );
  converter.instructions.push(
    new PropertyGetInstruction(
      lengthVar,
      listOperand,
      isDataList ? "Count" : "length",
    ),
  );

  const loopStart = converter.newLabel("set_ctor_start");
  const loopContinue = converter.newLabel("set_ctor_continue");
  const loopEnd = converter.newLabel("set_ctor_end");

  converter.instructions.push(new LabelInstruction(loopStart));
  const condTemp = converter.newTemp(PrimitiveTypes.boolean);
  converter.instructions.push(
    new BinaryOpInstruction(condTemp, indexVar, "<", lengthVar),
  );
  converter.instructions.push(
    new ConditionalJumpInstruction(condTemp, loopEnd),
  );

  let keyToken: TACOperand;
  if (isDataList) {
    keyToken = converter.newTemp(ExternTypes.dataToken);
    converter.instructions.push(
      new MethodCallInstruction(keyToken, listOperand, "get_Item", [indexVar]),
    );
  } else {
    const elementValue = converter.newTemp(elementType);
    converter.instructions.push(
      new ArrayAccessInstruction(elementValue, listOperand, indexVar),
    );
    keyToken = converter.wrapDataToken(elementValue);
  }

  const valueToken = converter.wrapDataToken(
    createConstant(true, PrimitiveTypes.boolean),
  );
  converter.instructions.push(
    new MethodCallInstruction(undefined, setOperand, "SetValue", [
      keyToken,
      valueToken,
    ]),
  );

  converter.instructions.push(new LabelInstruction(loopContinue));
  converter.instructions.push(
    new BinaryOpInstruction(
      indexVar,
      indexVar,
      "+",
      createConstant(1, PrimitiveTypes.int32),
    ),
  );
  converter.instructions.push(new UnconditionalJumpInstruction(loopStart));
  converter.instructions.push(new LabelInstruction(loopEnd));
}

function emitMapConstructor(
  converter: ASTToTACConverter,
  node: CallExpressionNode,
): TACOperand {
  const typeArgText = node.typeArguments?.length
    ? `Map<${node.typeArguments.join(", ")}>`
    : "Map";
  const mapType = converter.typeMapper.mapTypeScriptType(typeArgText);
  const mapResult = converter.newTemp(mapType);
  const ctorSig = converter.requireExternSignature(
    "DataDictionary",
    "ctor",
    "method",
    [],
    "DataDictionary",
  );
  converter.instructions.push(new CallInstruction(mapResult, ctorSig, []));

  if (node.arguments.length > 0) {
    if (node.arguments.length !== 1) {
      throw new Error("Map constructor expects at most one iterable argument.");
    }
    const iterableNode = node.arguments[0];
    const iterableOperand = converter.visitExpression(iterableNode);
    emitMapPopulateFromIterable(
      converter,
      mapResult,
      mapType,
      iterableNode,
      iterableOperand,
    );
  }

  return mapResult;
}

function emitMapPopulateFromIterable(
  converter: ASTToTACConverter,
  mapOperand: TACOperand,
  mapType: TypeSymbol,
  iterableNode: ASTNode,
  iterableOperand: TACOperand,
): void {
  const resolvedIterableType = resolveTypeFromNode(converter, iterableNode);
  const operandType = converter.getOperandType(iterableOperand);
  const keyType = resolveMapKeyType(mapType);
  const valueType = resolveMapValueType(mapType);

  let listOperand = iterableOperand;
  let isDataList = false;
  let pairElementType: TypeSymbol | null = null;

  const isArrayType =
    operandType instanceof ArrayTypeSymbol ||
    operandType.udonType === UdonType.Array ||
    resolvedIterableType instanceof ArrayTypeSymbol ||
    resolvedIterableType?.udonType === UdonType.Array;

  const isDataListType =
    operandType instanceof DataListTypeSymbol ||
    operandType.name === ExternTypes.dataList.name ||
    operandType.udonType === UdonType.DataList ||
    resolvedIterableType instanceof DataListTypeSymbol ||
    resolvedIterableType?.name === ExternTypes.dataList.name ||
    resolvedIterableType?.udonType === UdonType.DataList;

  const isDictionaryType =
    (isMapCollectionType(operandType) ||
      isMapCollectionType(resolvedIterableType) ||
      operandType === ExternTypes.dataDictionary ||
      operandType.name === ExternTypes.dataDictionary.name ||
      operandType.udonType === UdonType.DataDictionary ||
      resolvedIterableType === ExternTypes.dataDictionary ||
      resolvedIterableType?.name === ExternTypes.dataDictionary.name ||
      resolvedIterableType?.udonType === UdonType.DataDictionary) &&
    !isSetCollectionType(operandType) &&
    !isSetCollectionType(resolvedIterableType);

  if (operandType instanceof ArrayTypeSymbol) {
    pairElementType = operandType.elementType;
  } else if (resolvedIterableType instanceof ArrayTypeSymbol) {
    pairElementType = resolvedIterableType.elementType;
  } else if (operandType instanceof DataListTypeSymbol) {
    pairElementType = operandType.elementType;
  } else if (resolvedIterableType instanceof DataListTypeSymbol) {
    pairElementType = resolvedIterableType.elementType;
  }

  if (isDictionaryType) {
    listOperand = emitMapKeysList(converter, iterableOperand, keyType);
    isDataList = true;
  } else if (isArrayType) {
    // Array iterable of [key, value] pairs, keep listOperand as-is.
  } else if (isDataListType) {
    isDataList = true;
  } else {
    throw new Error(
      "Map constructor expects an Array, DataList, or Map iterable.",
    );
  }

  const indexVar = converter.newTemp(PrimitiveTypes.int32);
  const lengthVar = converter.newTemp(PrimitiveTypes.int32);
  converter.instructions.push(
    new AssignmentInstruction(
      indexVar,
      createConstant(0, PrimitiveTypes.int32),
    ),
  );
  converter.instructions.push(
    new PropertyGetInstruction(
      lengthVar,
      listOperand,
      isDataList ? "Count" : "length",
    ),
  );

  const loopStart = converter.newLabel("map_ctor_start");
  const loopContinue = converter.newLabel("map_ctor_continue");
  const loopEnd = converter.newLabel("map_ctor_end");

  converter.instructions.push(new LabelInstruction(loopStart));
  const condTemp = converter.newTemp(PrimitiveTypes.boolean);
  converter.instructions.push(
    new BinaryOpInstruction(condTemp, indexVar, "<", lengthVar),
  );
  converter.instructions.push(
    new ConditionalJumpInstruction(condTemp, loopEnd),
  );

  let keyToken: TACOperand;
  let valueToken: TACOperand;

  if (isDictionaryType) {
    const dictKeyToken = converter.newTemp(ExternTypes.dataToken);
    converter.instructions.push(
      new MethodCallInstruction(dictKeyToken, listOperand, "get_Item", [
        indexVar,
      ]),
    );
    const dictValueToken = converter.newTemp(ExternTypes.dataToken);
    converter.instructions.push(
      new MethodCallInstruction(dictValueToken, iterableOperand, "GetValue", [
        dictKeyToken,
      ]),
    );
    keyToken = dictKeyToken;
    valueToken = dictValueToken;
  } else if (isDataList) {
    const pairToken = converter.newTemp(ExternTypes.dataToken);
    converter.instructions.push(
      new MethodCallInstruction(pairToken, listOperand, "get_Item", [indexVar]),
    );
    const pairList = converter.unwrapDataToken(pairToken, ExternTypes.dataList);
    const pairKeyToken = converter.newTemp(ExternTypes.dataToken);
    const pairValueToken = converter.newTemp(ExternTypes.dataToken);
    converter.instructions.push(
      new MethodCallInstruction(pairKeyToken, pairList, "get_Item", [
        createConstant(0, PrimitiveTypes.int32),
      ]),
    );
    converter.instructions.push(
      new MethodCallInstruction(pairValueToken, pairList, "get_Item", [
        createConstant(1, PrimitiveTypes.int32),
      ]),
    );
    keyToken = pairKeyToken;
    valueToken = pairValueToken;
  } else {
    const pairValue = converter.newTemp(pairElementType ?? ObjectType);
    converter.instructions.push(
      new ArrayAccessInstruction(pairValue, listOperand, indexVar),
    );
    const pairValueType =
      pairElementType ?? converter.getOperandType(pairValue);
    if (pairValueType instanceof ArrayTypeSymbol) {
      const keyValue = converter.newTemp(keyType);
      const valueValue = converter.newTemp(valueType);
      converter.instructions.push(
        new ArrayAccessInstruction(
          keyValue,
          pairValue,
          createConstant(0, PrimitiveTypes.int32),
        ),
      );
      converter.instructions.push(
        new ArrayAccessInstruction(
          valueValue,
          pairValue,
          createConstant(1, PrimitiveTypes.int32),
        ),
      );
      keyToken = converter.wrapDataToken(keyValue);
      valueToken = converter.wrapDataToken(valueValue);
    } else if (
      pairValueType instanceof DataListTypeSymbol ||
      pairValueType.name === ExternTypes.dataList.name
    ) {
      const pairKeyToken = converter.newTemp(ExternTypes.dataToken);
      const pairValueToken = converter.newTemp(ExternTypes.dataToken);
      converter.instructions.push(
        new MethodCallInstruction(pairKeyToken, pairValue, "get_Item", [
          createConstant(0, PrimitiveTypes.int32),
        ]),
      );
      converter.instructions.push(
        new MethodCallInstruction(pairValueToken, pairValue, "get_Item", [
          createConstant(1, PrimitiveTypes.int32),
        ]),
      );
      keyToken = pairKeyToken;
      valueToken = pairValueToken;
    } else {
      throw new Error(
        "Map constructor expects iterable of [key, value] pairs.",
      );
    }
  }

  converter.instructions.push(
    new MethodCallInstruction(undefined, mapOperand, "SetValue", [
      keyToken,
      valueToken,
    ]),
  );

  converter.instructions.push(new LabelInstruction(loopContinue));
  converter.instructions.push(
    new BinaryOpInstruction(
      indexVar,
      indexVar,
      "+",
      createConstant(1, PrimitiveTypes.int32),
    ),
  );
  converter.instructions.push(new UnconditionalJumpInstruction(loopStart));
  converter.instructions.push(new LabelInstruction(loopEnd));
}

function visitSetMethodCall(
  converter: ASTToTACConverter,
  setOperand: TACOperand,
  setType: CollectionTypeSymbol,
  propAccess: PropertyAccessExpressionNode,
  rawArgs: ASTNode[],
): TACOperand | null {
  const elementType = resolveSetElementType(setType);

  switch (propAccess.property) {
    case "add": {
      if (rawArgs.length !== 1) {
        throw new Error("Set.add expects one argument.");
      }
      const value = converter.visitExpression(rawArgs[0]);
      const keyToken = converter.wrapDataToken(value);
      const valueToken = converter.wrapDataToken(
        createConstant(true, PrimitiveTypes.boolean),
      );
      converter.instructions.push(
        new MethodCallInstruction(undefined, setOperand, "SetValue", [
          keyToken,
          valueToken,
        ]),
      );
      return setOperand;
    }
    case "has": {
      if (rawArgs.length !== 1) {
        throw new Error("Set.has expects one argument.");
      }
      const value = converter.visitExpression(rawArgs[0]);
      const keyToken = converter.wrapDataToken(value);
      const result = converter.newTemp(PrimitiveTypes.boolean);
      converter.instructions.push(
        new MethodCallInstruction(result, setOperand, "ContainsKey", [
          keyToken,
        ]),
      );
      return result;
    }
    case "delete": {
      if (rawArgs.length !== 1) {
        throw new Error("Set.delete expects one argument.");
      }
      const value = converter.visitExpression(rawArgs[0]);
      const keyToken = converter.wrapDataToken(value);
      const result = converter.newTemp(PrimitiveTypes.boolean);
      converter.instructions.push(
        new MethodCallInstruction(result, setOperand, "Remove", [keyToken]),
      );
      return result;
    }
    case "clear": {
      if (rawArgs.length !== 0) {
        throw new Error("Set.clear expects no arguments.");
      }
      converter.instructions.push(
        new MethodCallInstruction(undefined, setOperand, "Clear", []),
      );
      return VOID_RETURN;
    }
    case "values":
    case "keys": {
      if (rawArgs.length !== 0) {
        throw new Error("Set.values/keys expects no arguments.");
      }
      return emitSetKeysList(converter, setOperand, elementType);
    }
    case "entries": {
      if (rawArgs.length !== 0) {
        throw new Error("Set.entries expects no arguments.");
      }
      const keysList = emitSetKeysList(converter, setOperand, elementType);
      const entriesType = new DataListTypeSymbol(ExternTypes.dataToken);
      const entriesResult = converter.newTemp(entriesType);
      const listCtorSig = converter.requireExternSignature(
        "DataList",
        "ctor",
        "method",
        [],
        "DataList",
      );
      converter.instructions.push(
        new CallInstruction(entriesResult, listCtorSig, []),
      );

      const indexVar = converter.newTemp(PrimitiveTypes.int32);
      const lengthVar = converter.newTemp(PrimitiveTypes.int32);
      converter.instructions.push(
        new AssignmentInstruction(
          indexVar,
          createConstant(0, PrimitiveTypes.int32),
        ),
      );
      converter.instructions.push(
        new PropertyGetInstruction(lengthVar, keysList, "Count"),
      );

      const loopStart = converter.newLabel("set_entries_start");
      const loopContinue = converter.newLabel("set_entries_continue");
      const loopEnd = converter.newLabel("set_entries_end");

      converter.instructions.push(new LabelInstruction(loopStart));
      const condTemp = converter.newTemp(PrimitiveTypes.boolean);
      converter.instructions.push(
        new BinaryOpInstruction(condTemp, indexVar, "<", lengthVar),
      );
      converter.instructions.push(
        new ConditionalJumpInstruction(condTemp, loopEnd),
      );

      const keyToken = converter.newTemp(ExternTypes.dataToken);
      converter.instructions.push(
        new MethodCallInstruction(keyToken, keysList, "get_Item", [indexVar]),
      );

      const pairList = converter.newTemp(
        new DataListTypeSymbol(ExternTypes.dataToken),
      );
      converter.instructions.push(
        new CallInstruction(pairList, listCtorSig, []),
      );
      converter.instructions.push(
        new MethodCallInstruction(undefined, pairList, "Add", [keyToken]),
      );
      const valueToken = keyToken;
      converter.instructions.push(
        new MethodCallInstruction(undefined, pairList, "Add", [valueToken]),
      );
      const pairToken = converter.wrapDataToken(pairList);
      converter.instructions.push(
        new MethodCallInstruction(undefined, entriesResult, "Add", [pairToken]),
      );

      converter.instructions.push(new LabelInstruction(loopContinue));
      converter.instructions.push(
        new BinaryOpInstruction(
          indexVar,
          indexVar,
          "+",
          createConstant(1, PrimitiveTypes.int32),
        ),
      );
      converter.instructions.push(new UnconditionalJumpInstruction(loopStart));
      converter.instructions.push(new LabelInstruction(loopEnd));

      return entriesResult;
    }
    case "forEach": {
      if (rawArgs.length < 1) {
        throw new Error("Set.forEach expects a callback argument.");
      }
      const callbackNode = rawArgs[0];
      if (callbackNode.kind !== ASTNodeKind.FunctionExpression) {
        throw new Error(
          "Set.forEach currently requires an inline function or arrow callback.",
        );
      }
      const callback = callbackNode as FunctionExpressionNode;
      let thisOverride: TACOperand | null = null;
      if (!callback.isArrow) {
        if (rawArgs.length >= 2) {
          const thisArg = converter.visitExpression(rawArgs[1]);
          const thisArgTemp = converter.newTemp(
            converter.getOperandType(thisArg),
          );
          converter.instructions.push(
            new CopyInstruction(thisArgTemp, thisArg),
          );
          thisOverride = thisArgTemp;
        } else {
          thisOverride = createConstant(null, ObjectType);
        }
      }

      const keysList = emitSetKeysList(converter, setOperand, elementType);
      const indexVar = converter.newTemp(PrimitiveTypes.int32);
      const lengthVar = converter.newTemp(PrimitiveTypes.int32);
      converter.instructions.push(
        new AssignmentInstruction(
          indexVar,
          createConstant(0, PrimitiveTypes.int32),
        ),
      );
      converter.instructions.push(
        new PropertyGetInstruction(lengthVar, keysList, "Count"),
      );

      const loopStart = converter.newLabel("set_foreach_start");
      const loopContinue = converter.newLabel("set_foreach_continue");
      const loopEnd = converter.newLabel("set_foreach_end");

      converter.symbolTable.enterScope();
      const paramVars = callback.parameters.map((param, index) => {
        let paramType = param.type ?? ObjectType;
        if (index === 0 || index === 1) {
          paramType = elementType;
        } else if (index === 2) {
          paramType = setType;
        }
        if (!converter.symbolTable.hasInCurrentScope(param.name)) {
          converter.symbolTable.addSymbol(param.name, paramType, false, false);
        }
        return createVariable(param.name, paramType, { isLocal: true });
      });

      converter.instructions.push(new LabelInstruction(loopStart));
      const condTemp = converter.newTemp(PrimitiveTypes.boolean);
      converter.instructions.push(
        new BinaryOpInstruction(condTemp, indexVar, "<", lengthVar),
      );
      converter.instructions.push(
        new ConditionalJumpInstruction(condTemp, loopEnd),
      );

      const keyToken = converter.newTemp(ExternTypes.dataToken);
      converter.instructions.push(
        new MethodCallInstruction(keyToken, keysList, "get_Item", [indexVar]),
      );
      const value = converter.unwrapDataToken(keyToken, elementType);

      if (paramVars[0]) {
        converter.instructions.push(new CopyInstruction(paramVars[0], value));
      }
      if (paramVars[1]) {
        converter.instructions.push(new CopyInstruction(paramVars[1], value));
      }
      if (paramVars[2]) {
        converter.instructions.push(
          new CopyInstruction(paramVars[2], setOperand),
        );
      }

      const previousThisOverride = converter.currentThisOverride;
      if (thisOverride) {
        converter.currentThisOverride = thisOverride;
      }
      if (callback.body.kind === ASTNodeKind.BlockStatement) {
        converter.visitBlockStatement(callback.body as BlockStatementNode);
      } else {
        converter.visitExpression(callback.body);
      }
      converter.currentThisOverride = previousThisOverride;

      converter.instructions.push(new LabelInstruction(loopContinue));
      converter.instructions.push(
        new BinaryOpInstruction(
          indexVar,
          indexVar,
          "+",
          createConstant(1, PrimitiveTypes.int32),
        ),
      );
      converter.instructions.push(new UnconditionalJumpInstruction(loopStart));
      converter.instructions.push(new LabelInstruction(loopEnd));
      converter.symbolTable.exitScope();

      return VOID_RETURN;
    }
    default:
      return null;
  }
}

function visitMapMethodCall(
  converter: ASTToTACConverter,
  mapOperand: TACOperand,
  mapType: CollectionTypeSymbol,
  propAccess: PropertyAccessExpressionNode,
  rawArgs: ASTNode[],
): TACOperand | null {
  const keyType = resolveMapKeyType(mapType);
  const valueType = resolveMapValueType(mapType);
  const unwrapToken = (
    token: TACOperand,
    targetType: TypeSymbol,
  ): TACOperand =>
    targetType.name === ExternTypes.dataToken.name
      ? token
      : converter.unwrapDataToken(token, targetType);

  switch (propAccess.property) {
    case "set": {
      if (rawArgs.length !== 2) {
        throw new Error("Map.set expects two arguments.");
      }
      const keyValue = converter.visitExpression(rawArgs[0]);
      const valueValue = converter.visitExpression(rawArgs[1]);
      const keyToken = converter.wrapDataToken(keyValue);
      const valueToken = converter.wrapDataToken(valueValue);
      converter.instructions.push(
        new MethodCallInstruction(undefined, mapOperand, "SetValue", [
          keyToken,
          valueToken,
        ]),
      );
      return mapOperand;
    }
    case "get": {
      if (rawArgs.length !== 1) {
        throw new Error("Map.get expects one argument.");
      }
      const keyValue = converter.visitExpression(rawArgs[0]);
      const keyToken = converter.wrapDataToken(keyValue);
      const valueToken = converter.newTemp(ExternTypes.dataToken);
      converter.instructions.push(
        new MethodCallInstruction(valueToken, mapOperand, "GetValue", [
          keyToken,
        ]),
      );
      return unwrapToken(valueToken, valueType);
    }
    case "has": {
      if (rawArgs.length !== 1) {
        throw new Error("Map.has expects one argument.");
      }
      const keyValue = converter.visitExpression(rawArgs[0]);
      const keyToken = converter.wrapDataToken(keyValue);
      const result = converter.newTemp(PrimitiveTypes.boolean);
      converter.instructions.push(
        new MethodCallInstruction(result, mapOperand, "ContainsKey", [
          keyToken,
        ]),
      );
      return result;
    }
    case "delete": {
      if (rawArgs.length !== 1) {
        throw new Error("Map.delete expects one argument.");
      }
      const keyValue = converter.visitExpression(rawArgs[0]);
      const keyToken = converter.wrapDataToken(keyValue);
      const result = converter.newTemp(PrimitiveTypes.boolean);
      converter.instructions.push(
        new MethodCallInstruction(result, mapOperand, "Remove", [keyToken]),
      );
      return result;
    }
    case "clear": {
      if (rawArgs.length !== 0) {
        throw new Error("Map.clear expects no arguments.");
      }
      converter.instructions.push(
        new MethodCallInstruction(undefined, mapOperand, "Clear", []),
      );
      return VOID_RETURN;
    }
    case "keys": {
      if (rawArgs.length !== 0) {
        throw new Error("Map.keys expects no arguments.");
      }
      return emitMapKeysList(converter, mapOperand, keyType);
    }
    case "values": {
      if (rawArgs.length !== 0) {
        throw new Error("Map.values expects no arguments.");
      }
      return emitMapValuesList(converter, mapOperand, valueType);
    }
    case "entries": {
      if (rawArgs.length !== 0) {
        throw new Error("Map.entries expects no arguments.");
      }
      return emitMapEntriesList(converter, mapOperand, keyType);
    }
    case "forEach": {
      if (rawArgs.length < 1) {
        throw new Error("Map.forEach expects a callback argument.");
      }
      const callbackNode = rawArgs[0];
      if (callbackNode.kind !== ASTNodeKind.FunctionExpression) {
        throw new Error(
          "Map.forEach currently requires an inline function or arrow callback.",
        );
      }
      const callback = callbackNode as FunctionExpressionNode;
      let thisOverride: TACOperand | null = null;
      if (!callback.isArrow) {
        if (rawArgs.length >= 2) {
          const thisArg = converter.visitExpression(rawArgs[1]);
          const thisArgTemp = converter.newTemp(
            converter.getOperandType(thisArg),
          );
          converter.instructions.push(
            new CopyInstruction(thisArgTemp, thisArg),
          );
          thisOverride = thisArgTemp;
        } else {
          thisOverride = createConstant(null, ObjectType);
        }
      }

      const keysList = emitMapKeysList(converter, mapOperand, keyType);
      const indexVar = converter.newTemp(PrimitiveTypes.int32);
      const lengthVar = converter.newTemp(PrimitiveTypes.int32);
      converter.instructions.push(
        new AssignmentInstruction(
          indexVar,
          createConstant(0, PrimitiveTypes.int32),
        ),
      );
      converter.instructions.push(
        new PropertyGetInstruction(lengthVar, keysList, "Count"),
      );

      const loopStart = converter.newLabel("map_foreach_start");
      const loopContinue = converter.newLabel("map_foreach_continue");
      const loopEnd = converter.newLabel("map_foreach_end");

      converter.symbolTable.enterScope();
      const paramVars = callback.parameters.map((param, index) => {
        let paramType = param.type ?? ObjectType;
        if (index === 0) {
          paramType = valueType;
        } else if (index === 1) {
          paramType = keyType;
        } else if (index === 2) {
          paramType = mapType;
        }
        if (!converter.symbolTable.hasInCurrentScope(param.name)) {
          converter.symbolTable.addSymbol(param.name, paramType, false, false);
        }
        return createVariable(param.name, paramType, { isLocal: true });
      });

      converter.instructions.push(new LabelInstruction(loopStart));
      const condTemp = converter.newTemp(PrimitiveTypes.boolean);
      converter.instructions.push(
        new BinaryOpInstruction(condTemp, indexVar, "<", lengthVar),
      );
      converter.instructions.push(
        new ConditionalJumpInstruction(condTemp, loopEnd),
      );

      const keyToken = converter.newTemp(ExternTypes.dataToken);
      converter.instructions.push(
        new MethodCallInstruction(keyToken, keysList, "get_Item", [indexVar]),
      );
      const valueToken = converter.newTemp(ExternTypes.dataToken);
      converter.instructions.push(
        new MethodCallInstruction(valueToken, mapOperand, "GetValue", [
          keyToken,
        ]),
      );

      const keyValue = unwrapToken(keyToken, keyType);
      const valueValue = unwrapToken(valueToken, valueType);

      if (paramVars[0]) {
        converter.instructions.push(
          new CopyInstruction(paramVars[0], valueValue),
        );
      }
      if (paramVars[1]) {
        converter.instructions.push(
          new CopyInstruction(paramVars[1], keyValue),
        );
      }
      if (paramVars[2]) {
        converter.instructions.push(
          new CopyInstruction(paramVars[2], mapOperand),
        );
      }

      const previousThisOverride = converter.currentThisOverride;
      if (thisOverride) {
        converter.currentThisOverride = thisOverride;
      }
      if (callback.body.kind === ASTNodeKind.BlockStatement) {
        converter.visitBlockStatement(callback.body as BlockStatementNode);
      } else {
        converter.visitExpression(callback.body);
      }
      converter.currentThisOverride = previousThisOverride;

      converter.instructions.push(new LabelInstruction(loopContinue));
      converter.instructions.push(
        new BinaryOpInstruction(
          indexVar,
          indexVar,
          "+",
          createConstant(1, PrimitiveTypes.int32),
        ),
      );
      converter.instructions.push(new UnconditionalJumpInstruction(loopStart));
      converter.instructions.push(new LabelInstruction(loopEnd));
      converter.symbolTable.exitScope();

      return VOID_RETURN;
    }
    default:
      return null;
  }
}

const resolveExternReturnType = (externSig: string): TypeSymbol | null => {
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

export function getUdonTypeConverterTargetType(
  this: ASTToTACConverter,
  methodName: string,
): TypeSymbol | null {
  switch (methodName) {
    case "toUdonByte":
      return this.typeMapper.mapTypeScriptType("UdonByte");
    case "toUdonInt":
      return this.typeMapper.mapTypeScriptType("UdonInt");
    case "toUdonFloat":
      return this.typeMapper.mapTypeScriptType("UdonFloat");
    case "toUdonDouble":
      return this.typeMapper.mapTypeScriptType("UdonDouble");
    case "toUdonLong":
    case "numberToUdonLong":
      return this.typeMapper.mapTypeScriptType("UdonLong");
    case "toUdonULong":
    case "numberToUdonULong":
      return this.typeMapper.mapTypeScriptType("UdonULong");
    default:
      return null;
  }
}

export function visitObjectStaticCall(
  this: ASTToTACConverter,
  methodName: string,
  args: TACOperand[],
): TACOperand | null {
  if (args.length !== 1) return null;
  const target = args[0];
  const targetType = this.getOperandType(target);
  if (targetType.name !== ExternTypes.dataDictionary.name) {
    return null;
  }

  switch (methodName) {
    case "keys":
      return this.emitDataDictionaryKeys(target);
    case "values":
      return this.emitDataDictionaryValues(target);
    case "entries":
      return this.emitDataDictionaryEntries(target);
    default:
      return null;
  }
}

export function visitNumberStaticCall(
  this: ASTToTACConverter,
  methodName: string,
  args: TACOperand[],
): TACOperand | null {
  switch (methodName) {
    case "isFinite": {
      if (args.length !== 1) return null;
      const value = args[0];
      const notNaN = this.newTemp(PrimitiveTypes.boolean);
      this.instructions.push(
        new BinaryOpInstruction(notNaN, value, "==", value),
      );
      const notPosInf = this.newTemp(PrimitiveTypes.boolean);
      this.instructions.push(
        new BinaryOpInstruction(
          notPosInf,
          value,
          "!=",
          createConstant(Infinity, PrimitiveTypes.single),
        ),
      );
      const notNegInf = this.newTemp(PrimitiveTypes.boolean);
      this.instructions.push(
        new BinaryOpInstruction(
          notNegInf,
          value,
          "!=",
          createConstant(-Infinity, PrimitiveTypes.single),
        ),
      );
      const temp = this.newTemp(PrimitiveTypes.boolean);
      this.instructions.push(
        new BinaryOpInstruction(temp, notNaN, "&&", notPosInf),
      );
      const result = this.newTemp(PrimitiveTypes.boolean);
      this.instructions.push(
        new BinaryOpInstruction(result, temp, "&&", notNegInf),
      );
      return result;
    }
    case "parseInt": {
      if (args.length === 0) return null;
      if (args.length > 2) {
        throw new Error("Number.parseInt(...) expects one or two arguments.");
      }
      if (args.length === 2) {
        const radix = args[1];
        if (!isLiteralRadix10(radix)) {
          throw new Error(
            "parseInt with radix is not supported by the transpiler",
          );
        }
      }
      const value = args[0];
      const result = this.newTemp(PrimitiveTypes.int32);
      const externSig = this.requireExternSignature(
        "Int32",
        "Parse",
        "method",
        ["string"],
        "int",
      );
      this.instructions.push(new CallInstruction(result, externSig, [value]));
      return result;
    }
    default:
      return null;
  }
}

export function visitMathStaticCall(
  this: ASTToTACConverter,
  methodName: string,
  args: TACOperand[],
): TACOperand | null {
  if (methodName === "random") {
    return createConstant(0, PrimitiveTypes.single);
  }

  if (methodName === "imul") {
    if (args.length !== 2) return null;
    const result = this.newTemp(PrimitiveTypes.int32);
    this.instructions.push(
      new BinaryOpInstruction(result, args[0], "*", args[1]),
    );
    return result;
  }

  const methodMap: Record<string, string> = {
    floor: "Floor",
    ceil: "Ceil",
    round: "Round",
    abs: "Abs",
    max: "Max",
    min: "Min",
    sqrt: "Sqrt",
    sin: "Sin",
    cos: "Cos",
    tan: "Tan",
    pow: "Pow",
  };
  const mapped = methodMap[methodName];
  if (!mapped) return null;

  if (methodName === "max" || methodName === "min") {
    if (args.length < 2) return null;
    let current = args[0];
    for (let i = 1; i < args.length; i += 1) {
      const stepResult = this.newTemp(PrimitiveTypes.single);
      const externSig = this.resolveStaticExtern("Mathf", mapped, "method");
      if (!externSig) return null;
      this.instructions.push(
        new CallInstruction(stepResult, externSig, [current, args[i]]),
      );
      current = stepResult;
    }
    return current;
  }

  if (args.length !== 1 && methodName !== "pow") return null;
  if (methodName === "pow" && args.length !== 2) return null;

  const result = this.newTemp(PrimitiveTypes.single);
  const externSig = this.resolveStaticExtern("Mathf", mapped, "method");
  if (!externSig) return null;
  this.instructions.push(new CallInstruction(result, externSig, args));
  return result;
}

export function visitArrayStaticCall(
  this: ASTToTACConverter,
  methodName: string,
  args: TACOperand[],
): TACOperand | null {
  switch (methodName) {
    case "from": {
      if (args.length < 1) return null;
      const source = args[0];
      const sourceType = this.getOperandType(source);
      if (
        sourceType instanceof CollectionTypeSymbol &&
        sourceType.name === ExternTypes.dataDictionary.name
      ) {
        const keyType = sourceType.keyType ?? ObjectType;
        return emitMapEntriesList(this, source, keyType);
      }
      if (
        sourceType === ExternTypes.dataDictionary ||
        sourceType.name === ExternTypes.dataDictionary.name ||
        sourceType.udonType === UdonType.DataDictionary
      ) {
        return emitMapEntriesList(this, source, ObjectType);
      }

      // If source is a DataList or an Array, Array.from should produce a new
      // DataList with copied elements (JS semantics). Detect DataList/Array
      // operands and emit a copy loop that constructs a new DataList and adds
      // each element.
      const isListOrArrayType =
        sourceType instanceof DataListTypeSymbol ||
        sourceType.name === ExternTypes.dataList.name ||
        sourceType.udonType === UdonType.DataList ||
        sourceType instanceof ArrayTypeSymbol ||
        sourceType.udonType === UdonType.Array;

      if (isListOrArrayType) {
        const isArraySource =
          sourceType instanceof ArrayTypeSymbol ||
          sourceType.udonType === UdonType.Array;

        const elementType =
          "elementType" in sourceType
            ? sourceType.elementType
            : isArraySource
              ? ObjectType
              : ExternTypes.dataToken;

        const listResult = this.newTemp(new DataListTypeSymbol(elementType));
        const listCtorSig = this.requireExternSignature(
          "DataList",
          "ctor",
          "method",
          [],
          "DataList",
        );
        this.instructions.push(
          new CallInstruction(listResult, listCtorSig, []),
        );

        const indexVar = this.newTemp(PrimitiveTypes.int32);
        const lengthVar = this.newTemp(PrimitiveTypes.int32);
        this.instructions.push(
          new AssignmentInstruction(
            indexVar,
            createConstant(0, PrimitiveTypes.int32),
          ),
        );

        // Use Count for DataList, length for Array
        const lengthProp = !isArraySource ? "Count" : "length";
        this.instructions.push(
          new PropertyGetInstruction(lengthVar, source, lengthProp),
        );

        const loopStart = this.newLabel("array_from_start");
        const loopContinue = this.newLabel("array_from_continue");
        const loopEnd = this.newLabel("array_from_end");

        this.instructions.push(new LabelInstruction(loopStart));
        const condTemp = this.newTemp(PrimitiveTypes.boolean);
        this.instructions.push(
          new BinaryOpInstruction(condTemp, indexVar, "<", lengthVar),
        );
        this.instructions.push(
          new ConditionalJumpInstruction(condTemp, loopEnd),
        );

        if (!isArraySource) {
          const itemToken = this.newTemp(ExternTypes.dataToken);
          this.instructions.push(
            new MethodCallInstruction(itemToken, source, "get_Item", [
              indexVar,
            ]),
          );
          this.instructions.push(
            new MethodCallInstruction(undefined, listResult, "Add", [
              itemToken,
            ]),
          );
        } else {
          const elementValue = this.newTemp(elementType);
          this.instructions.push(
            new ArrayAccessInstruction(elementValue, source, indexVar),
          );
          const token = this.wrapDataToken(elementValue);
          this.instructions.push(
            new MethodCallInstruction(undefined, listResult, "Add", [token]),
          );
        }

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

        return listResult;
      }

      // Unsupported iterable type for Array.from
      throw new Error(
        `Array.from expects an Array, DataList, or DataDictionary iterable; received ${sourceType?.name ?? String(sourceType)}`,
      );
    }
    case "isArray": {
      if (args.length !== 1) return null;
      const target = args[0];
      const targetType = this.getOperandType(target);
      if (
        targetType.udonType === UdonType.Array ||
        targetType.udonType === UdonType.DataList
      ) {
        return createConstant(true, PrimitiveTypes.boolean);
      }
      if (targetType.udonType !== UdonType.Object) {
        return createConstant(false, PrimitiveTypes.boolean);
      }
      const externSig = this.resolveStaticExtern("Array", "isArray", "method");
      if (!externSig) {
        throw new Error("Missing extern signature for Array.isArray");
      }
      const result = this.newTemp(PrimitiveTypes.boolean);
      this.instructions.push(new CallInstruction(result, externSig, [target]));
      return result;
    }
    default:
      return null;
  }
}

export function resolveStaticExtern(
  this: ASTToTACConverter,
  typeName: string,
  memberName: string,
  accessType: "method" | "getter",
): string | null {
  const direct = resolveExternSignature(typeName, memberName, accessType);
  if (direct) return direct;
  if (accessType === "getter") {
    return resolveExternSignature(typeName, memberName, "method");
  }
  return null;
}
