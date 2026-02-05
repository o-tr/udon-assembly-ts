import { resolveExternSignature } from "../../../codegen/extern_signatures.js";
import { computeTypeId } from "../../../codegen/type_metadata_registry.js";
import { isTsOnlyCallExpression } from "../../../frontend/ts_only.js";
import type { TypeSymbol } from "../../../frontend/type_symbols.js";
import {
  ArrayTypeSymbol,
  DataListTypeSymbol,
  ExternTypes,
  ObjectType,
  PrimitiveTypes,
} from "../../../frontend/type_symbols.js";
import {
  ASTNodeKind,
  type CallExpressionNode,
  type IdentifierNode,
  type OptionalChainingExpressionNode,
  type PropertyAccessExpressionNode,
  UdonType,
} from "../../../frontend/types.js";
import {
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
  type TACOperand,
  TACOperandKind,
} from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";

export function visitCallExpression(
  this: ASTToTACConverter,
  node: CallExpressionNode,
): TACOperand {
  const callee = node.callee;
  if (isTsOnlyCallExpression(node)) {
    return createConstant(null, ObjectType);
  }

  const args = node.arguments.map((arg) => this.visitExpression(arg));
  const defaultResult = () => this.newTemp(ObjectType);
  if (callee.kind === ASTNodeKind.Identifier) {
    const calleeName = (callee as IdentifierNode).name;
    if (calleeName === "Error") {
      return args[0] ?? createConstant("Error", PrimitiveTypes.string);
    }
    if (calleeName === "BigInt") {
      if (args.length !== 1) {
        throw new Error("BigInt(...) expects one argument.");
      }
      const arg = args[0] ?? createConstant(0, PrimitiveTypes.single);
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
    if (node.isNew && this.classMap.has(calleeName)) {
      return this.visitInlineConstructor(calleeName, args);
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
      const paramTypes = args.map((arg) => this.getOperandType(arg).name);
      const externSig = this.requireExternSignature(
        calleeName,
        "ctor",
        "method",
        paramTypes,
        calleeName,
      );
      this.instructions.push(
        new CallInstruction(collectionResult, externSig, args),
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
    if (node.isNew && calleeName === "Array" && args.length > 0) {
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
      for (const arg of args) {
        const token = this.wrapDataToken(arg);
        this.instructions.push(
          new MethodCallInstruction(undefined, listResult, "Add", [token]),
        );
      }
      return listResult;
    }
    if (
      (calleeName === "Instantiate" || calleeName === "VRCInstantiate") &&
      args.length === 1
    ) {
      const instResult = this.newTemp(ExternTypes.gameObject);
      const externSig = this.requireExternSignature(
        "VRCInstantiate",
        "Instantiate",
        "method",
        ["GameObject"],
        "GameObject",
      );
      this.instructions.push(new CallInstruction(instResult, externSig, args));
      return instResult;
    }
    if (node.isNew && (calleeName === "Vector3" || calleeName === "Color")) {
      const externSig = `__ctor_${calleeName}`;
      const ctorType = this.typeMapper.mapTypeScriptType(calleeName);
      const ctorResult = this.newTemp(ctorType);
      this.instructions.push(new CallInstruction(ctorResult, externSig, args));
      return ctorResult;
    }
    const callResult = defaultResult();
    this.instructions.push(new CallInstruction(callResult, calleeName, args));
    return callResult;
  }

  if (callee.kind === ASTNodeKind.PropertyAccessExpression) {
    const propAccess = callee as PropertyAccessExpressionNode;

    if (
      propAccess.object.kind === ASTNodeKind.Identifier &&
      (propAccess.object as IdentifierNode).name === "UdonTypeConverters"
    ) {
      if (args.length !== 1) {
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
      this.instructions.push(new CastInstruction(castResult, args[0]));
      return castResult;
    }

    if (
      propAccess.object.kind === ASTNodeKind.Identifier &&
      (propAccess.object as IdentifierNode).name === "BigInt"
    ) {
      if (propAccess.property === "asUintN") {
        if (args.length !== 2) {
          throw new Error("BigInt.asUintN expects two arguments.");
        }
        return args[1] ?? createConstant(0, PrimitiveTypes.single);
      }
    }

    if (
      propAccess.object.kind === ASTNodeKind.Identifier &&
      (propAccess.object as IdentifierNode).name === "Object"
    ) {
      const objectResult = this.visitObjectStaticCall(
        propAccess.property,
        args,
      );
      if (objectResult) return objectResult;
    }

    if (
      propAccess.object.kind === ASTNodeKind.Identifier &&
      (propAccess.object as IdentifierNode).name === "Number"
    ) {
      const numberResult = this.visitNumberStaticCall(
        propAccess.property,
        args,
      );
      if (numberResult) return numberResult;
    }

    if (
      propAccess.object.kind === ASTNodeKind.Identifier &&
      (propAccess.object as IdentifierNode).name === "Math"
    ) {
      const mathResult = this.visitMathStaticCall(propAccess.property, args);
      if (mathResult) return mathResult;
    }

    if (
      propAccess.object.kind === ASTNodeKind.Identifier &&
      (propAccess.object as IdentifierNode).name === "Array"
    ) {
      const arrayResult = this.visitArrayStaticCall(propAccess.property, args);
      if (arrayResult) return arrayResult;
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
        args,
      );
      if (inlineResult) return inlineResult;
    }

    if (
      propAccess.object.kind === ASTNodeKind.Identifier &&
      this.resolveStaticExtern(
        (propAccess.object as IdentifierNode).name,
        propAccess.property,
        "method",
      )
    ) {
      const externSig = this.resolveStaticExtern(
        (propAccess.object as IdentifierNode).name,
        propAccess.property,
        "method",
      );
      if (externSig) {
        const returnType = resolveExternReturnType(externSig) ?? ObjectType;
        if (returnType === PrimitiveTypes.void) {
          this.instructions.push(
            new CallInstruction(undefined, externSig, args),
          );
          return createConstant(0, PrimitiveTypes.void);
        }
        const callResult = this.newTemp(returnType);
        this.instructions.push(
          new CallInstruction(callResult, externSig, args),
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
          new CallInstruction(undefined, externName, args),
        );
        return createConstant(0, PrimitiveTypes.void); // Console methods return void
      }
    }

    if (
      propAccess.property === "length" &&
      propAccess.object.kind === ASTNodeKind.Identifier
    ) {
      const array = this.visitExpression(propAccess.object);
      const lengthResult = this.newTemp(PrimitiveTypes.int32);
      const arrayType = this.getOperandType(array);
      const lengthProp =
        arrayType.name === ExternTypes.dataList.name ? "Count" : "length";
      this.instructions.push(
        new PropertyGetInstruction(lengthResult, array, lengthProp),
      );
      return lengthResult;
    }

    const object = this.visitExpression(propAccess.object);
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
      args.length === 1 &&
      args[0].kind === TACOperandKind.Constant
    ) {
      const _methodName = (args[0] as ConstantOperand).value as string;
      const externSig = this.requireExternSignature(
        "UdonBehaviour",
        "SendCustomEvent",
        "method",
        ["string"],
        "void",
      );
      this.instructions.push(
        new CallInstruction(undefined, externSig, [object, args[0]]),
      );
      return createConstant(0, PrimitiveTypes.void);
    }
    if (propAccess.property === "SendCustomNetworkEvent" && args.length === 2) {
      const externSig = this.requireExternSignature(
        "UdonBehaviour",
        "SendCustomNetworkEvent",
        "method",
        ["NetworkEventTarget", "string"],
        "void",
      );
      this.instructions.push(
        new CallInstruction(undefined, externSig, [object, args[0], args[1]]),
      );
      return createConstant(0, PrimitiveTypes.void);
    }
    const objectType = this.getOperandType(object);
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
          args.length,
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
              args[i],
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

      return createConstant(0, PrimitiveTypes.void);
    }
    if (objectType.name === ExternTypes.dataList.name) {
      if (propAccess.property === "Add" && args.length === 1) {
        const token = this.wrapDataToken(args[0]);
        this.instructions.push(
          new MethodCallInstruction(undefined, object, "Add", [token]),
        );
        return createConstant(0, PrimitiveTypes.void);
      }
      if (propAccess.property === "Remove" && args.length === 1) {
        const token = this.wrapDataToken(args[0]);
        const removeResult = this.newTemp(PrimitiveTypes.boolean);
        this.instructions.push(
          new MethodCallInstruction(removeResult, object, "Remove", [token]),
        );
        return removeResult;
      }
    }
    if (objectType.name === ExternTypes.dataDictionary.name) {
      if (propAccess.property === "SetValue" && args.length === 2) {
        const keyToken = this.wrapDataToken(args[0]);
        const valueToken = this.wrapDataToken(args[1]);
        this.instructions.push(
          new MethodCallInstruction(undefined, object, "SetValue", [
            keyToken,
            valueToken,
          ]),
        );
        return createConstant(0, PrimitiveTypes.void);
      }
      if (
        (propAccess.property === "ContainsKey" ||
          propAccess.property === "Remove") &&
        args.length === 1
      ) {
        const keyToken = this.wrapDataToken(args[0]);
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
              args,
            ),
          );
          return result;
        }
        case "map": {
          const result = this.newTemp(new ArrayTypeSymbol(ObjectType));
          this.instructions.push(
            new MethodCallInstruction(result, object, "map", args),
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
            new MethodCallInstruction(result, object, "find", args),
          );
          return result;
        }
        case "indexOf": {
          const result = this.newTemp(PrimitiveTypes.int32);
          this.instructions.push(
            new MethodCallInstruction(result, object, "indexOf", args),
          );
          return result;
        }
        case "includes": {
          const result = this.newTemp(PrimitiveTypes.boolean);
          this.instructions.push(
            new MethodCallInstruction(result, object, "includes", args),
          );
          return result;
        }
        case "join": {
          const result = this.newTemp(PrimitiveTypes.string);
          this.instructions.push(
            new MethodCallInstruction(result, object, "join", args),
          );
          return result;
        }
      }
    }
    if (propAccess.property === "RequestSerialization" && args.length === 0) {
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
      return createConstant(0, PrimitiveTypes.void);
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
        new MethodCallInstruction(undefined, object, propAccess.property, args),
      );
      return createConstant(0, PrimitiveTypes.void);
    }

    const callResult = this.newTemp(resolvedReturnType ?? ObjectType);
    this.instructions.push(
      new MethodCallInstruction(callResult, object, propAccess.property, args),
    );
    return callResult;
  }

  if (callee.kind === ASTNodeKind.OptionalChainingExpression) {
    const opt = callee as OptionalChainingExpressionNode;
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
    this.instructions.push(
      new ConditionalJumpInstruction(isNotNull, nullLabel),
    );

    this.instructions.push(
      new MethodCallInstruction(callResult, objTemp, opt.property, args),
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
    case "from":
      return args.length >= 1 ? args[0] : null;
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
