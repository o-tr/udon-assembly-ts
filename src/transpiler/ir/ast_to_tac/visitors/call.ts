import { resolveExternSignature } from "../../../codegen/extern_signatures.js";
import { typeMetadataRegistry } from "../../../codegen/type_metadata_registry.js";
import { mapTypeScriptToCSharp } from "../../../codegen/udon_type_resolver.js";
import { isTsOnlyCallExpression } from "../../../frontend/ts_only.js";
import type { TypeSymbol } from "../../../frontend/type_symbols.js";
import {
  ArrayTypeSymbol,
  CollectionTypeSymbol,
  DataListTypeSymbol,
  ExternTypes,
  InterfaceTypeSymbol,
  mapCSharpTypeToTypeSymbol,
  ObjectType,
  PrimitiveTypes,
} from "../../../frontend/type_symbols.js";
import {
  type ArrayLiteralExpressionNode,
  type ASTNode,
  ASTNodeKind,
  type BlockStatementNode,
  type CallExpressionNode,
  type FunctionExpressionNode,
  type IdentifierNode,
  isNumericUdonType,
  type LiteralNode,
  needsInt32IndexCoercion,
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
  createLabel,
  createVariable,
  type LabelOperand,
  type TACOperand,
  TACOperandKind,
  type VariableOperand,
} from "../../tac_operand.js";
import type { UdonBehaviourMethodLayout } from "../../udon_behaviour_layout.js";
import type { ASTToTACConverter } from "../converter.js";
import { emitArrayConcat } from "../helpers/assignment.js";
import {
  emitMapEntriesList,
  emitMapKeysList,
  isMapCollectionType,
  isSetCollectionType,
} from "../helpers/collections.js";
import { resolveExternReturnType } from "../helpers/extern.js";
import {
  emitDeferredInlineInitializers,
  getCurrentDeferredInitializerClassName,
  inlineSuperConstructorFromArgs,
  operandTrackingKey,
  resolveClassMethod,
  resolveClassNode,
  resolveConcreteClassName,
} from "../helpers/inline.js";
import { isAllInlineInterface } from "../helpers/udon_behaviour.js";
import { resolveTypeFromNode } from "./expression.js";

const VOID_RETURN: ConstantOperand = createConstant(null, ObjectType);
const MAX_UNTRACKED_DISPATCH_CANDIDATES = 100;
// D3 method dispatch inlines full method bodies per instance, so use a
// stricter limit than property dispatch to avoid excessive code bloat.
const MAX_D3_METHOD_DISPATCH_CANDIDATES = 20;

/**
 * Build a fallback IPC method layout from interface metadata when the
 * layout wasn't pre-built (e.g. implementing class is in another file).
 * Naming convention matches buildUdonBehaviourLayouts in udon_behaviour_layout.ts.
 * Results are cached per converter instance to avoid redundant computation.
 */
const fallbackLayoutCache = new WeakMap<
  ASTToTACConverter,
  Map<string, UdonBehaviourMethodLayout | undefined>
>();

function buildFallbackMethodLayout(
  converter: ASTToTACConverter,
  interfaceName: string,
  methodName: string,
): UdonBehaviourMethodLayout | undefined {
  let cache = fallbackLayoutCache.get(converter);
  if (!cache) {
    cache = new Map();
    fallbackLayoutCache.set(converter, cache);
  }
  const cacheKey = `${interfaceName}:${methodName}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const iface = converter.classRegistry?.getInterface(interfaceName);
  if (!iface) {
    cache.set(cacheKey, undefined);
    return undefined;
  }
  const method = iface.methods.find((m) => m.name === methodName);
  if (!method) {
    cache.set(cacheKey, undefined);
    return undefined;
  }

  const baseName = `${interfaceName}_${methodName}`;
  const parameterExportNames = method.parameters.map(
    (_, i) => `${baseName}__param_${i}`,
  );
  const parameterTypes = method.parameters.map((p) =>
    converter.typeMapper.mapTypeScriptType(p.type),
  );
  const returnType = converter.typeMapper.mapTypeScriptType(method.returnType);
  const returnExportName =
    returnType !== PrimitiveTypes.void ? `${baseName}__ret` : null;

  const layout: UdonBehaviourMethodLayout = {
    exportMethodName: baseName,
    returnExportName,
    parameterExportNames,
    parameterTypes,
    returnType,
    isPublic: true,
  };
  cache.set(cacheKey, layout);
  return layout;
}

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

/**
 * Resolve the inline class name for a property-access method call.
 * Returns the class name if the call target is an inline instance (or an
 * entry-point self-method), otherwise undefined.
 * When the tracked className is an interface/type alias, resolves to the
 * concrete implementing class so evaluateArgsWithExpectedTypes can find
 * the method signature.
 */
function resolveInlineClassName(
  converter: ASTToTACConverter,
  propAccess: PropertyAccessExpressionNode,
  object: TACOperand,
): string | undefined {
  if (propAccess.object.kind === ASTNodeKind.ThisExpression) {
    // Inline context self-method: this.method() inside an inline class body
    if (converter.currentInlineContext && !converter.currentThisOverride) {
      return converter.currentInlineContext.className;
    }
    // Entry-point class self-method: this.method() in the entry-point class
    if (
      converter.currentClassName &&
      converter.entryPointClasses.has(converter.currentClassName) &&
      !converter.currentInlineContext &&
      !converter.currentThisOverride
    ) {
      return converter.currentClassName;
    }
  }
  const key = operandTrackingKey(object);
  if (key) {
    const instanceInfo = converter.resolveInlineInstance(key);
    if (instanceInfo) {
      // When className is an interface/type alias, resolve to concrete class
      // so evaluateArgsWithExpectedTypes can find the method signature.
      return resolveConcreteClassName(converter, instanceInfo);
    }
  }
  return undefined;
}

/**
 * Evaluate call arguments, setting currentExpectedType for object literal
 * arguments whose corresponding parameter is an InterfaceTypeSymbol.
 * Returns the evaluated args array if any argument was an object literal
 * with an interface-typed parameter, otherwise null (letting getArgs()
 * evaluate normally).
 */
function evaluateArgsWithExpectedTypes(
  converter: ASTToTACConverter,
  className: string,
  methodName: string,
  rawArgs: ASTNode[],
): TACOperand[] | null {
  // Walk the inheritance chain to find the method (may be on a base class).
  // resolveClassMethod excludes UdonBehaviour and stub classes, so their
  // methods (dispatched via IPC) never enter this path.
  const resolved = resolveClassMethod(converter, className, methodName);
  if (!resolved) return null;
  const method = resolved.method;

  const hasTypedObjectArg = rawArgs.some(
    (arg, i) =>
      arg.kind === ASTNodeKind.ObjectLiteralExpression &&
      i < method.parameters.length &&
      method.parameters[i].type instanceof InterfaceTypeSymbol &&
      (method.parameters[i].type as InterfaceTypeSymbol).properties.size > 0,
  );
  if (!hasTypedObjectArg) return null;

  return rawArgs.map((arg, i) => {
    const paramType =
      i < method.parameters.length ? method.parameters[i].type : undefined;
    if (
      arg.kind === ASTNodeKind.ObjectLiteralExpression &&
      paramType instanceof InterfaceTypeSymbol &&
      paramType.properties.size > 0
    ) {
      const prev = converter.currentExpectedType;
      try {
        converter.currentExpectedType = paramType;
        return converter.visitExpression(arg);
      } finally {
        converter.currentExpectedType = prev;
      }
    }
    return converter.visitExpression(arg);
  });
}

/**
 * Merge inline tracking info across dispatch branches. Returns:
 * - `undefined` on first branch (no prior value),
 * - the mapping if all branches agree on className AND prefix,
 * - `null` if any branch disagrees or is untracked.
 */
function mergeInlineMapping(
  current: { prefix: string; className: string } | null | undefined,
  inlineRes: TACOperand,
  instanceMap: Map<string, { prefix: string; className: string }>,
): { prefix: string; className: string } | null {
  const resKey = operandTrackingKey(inlineRes);
  const branchMapping = resKey ? instanceMap.get(resKey) : undefined;
  if (current === undefined) {
    return branchMapping ?? null;
  }
  if (
    !branchMapping ||
    !current ||
    branchMapping.className !== current.className ||
    branchMapping.prefix !== current.prefix
  ) {
    return null;
  }
  return current;
}

/** Populate and return the implementor names cache for a type. */
function getOrPopulateImplementorNames(
  converter: ASTToTACConverter,
  typeName: string,
): Set<string> | null {
  if (!converter.implementorNamesCache.has(typeName)) {
    converter.implementorNamesCache.set(
      typeName,
      converter.classRegistry
        ? new Set(
            converter.classRegistry
              .getImplementorsOfInterface(typeName)
              .map((i) => i.name),
          )
        : null,
    );
  }
  return converter.implementorNamesCache.get(typeName) ?? null;
}

function tryUntrackedInlineDispatch(
  converter: ASTToTACConverter,
  object: TACOperand,
  objectType: TypeSymbol | null,
  propAccess: PropertyAccessExpressionNode,
  rawArgs: ASTNode[],
  evaluatedArgs: TACOperand[],
): TACOperand | null {
  // Untracked receiver fallback:
  // Tracking can be lost across temporary/copy-heavy flows (e.g. Map.get(...)!).
  // In that case, dispatch by runtime handle and inline the method body.
  const candidateClassNames = new Set<string>();
  const addCandidateClassesFromType = (
    type: TypeSymbol | null | undefined,
  ): void => {
    if (!type) return;
    const typeName = type.name;
    if (!typeName) return;
    if (
      resolveClassNode(converter, typeName) &&
      !converter.udonBehaviourClasses.has(typeName)
    ) {
      candidateClassNames.add(typeName);
      return;
    }
    if (converter.classRegistry?.getInterface(typeName)) {
      if (!isAllInlineInterface(converter, typeName)) return;
      for (const impl of converter.classRegistry.getImplementorsOfInterface(
        typeName,
      )) {
        if (!converter.udonBehaviourClasses.has(impl.name)) {
          candidateClassNames.add(impl.name);
        }
      }
    }
  };
  const objectTypeFromNode = resolveTypeFromNode(converter, propAccess.object);
  addCandidateClassesFromType(objectType);
  addCandidateClassesFromType(objectTypeFromNode);
  const hasInterfaceTypedReceiver = [objectType, objectTypeFromNode].some(
    (type) => {
      const typeName = type?.name;
      return !!typeName && !!converter.classRegistry?.getInterface(typeName);
    },
  );
  const isNonParameterVariableReceiver =
    object.kind === TACOperandKind.Variable &&
    !converter.symbolTable.lookup((object as VariableOperand).name)
      ?.isParameter;
  if (hasInterfaceTypedReceiver && isNonParameterVariableReceiver) {
    // Keep local interface aliases on the regular call path so they don't
    // eagerly lower to handle-dispatch blocks in post-loop alias-restore flows.
    return null;
  }

  if (
    candidateClassNames.size === 0 ||
    converter.allInlineInstances.size === 0
  ) {
    return null;
  }

  const candidateInstances = Array.from(converter.allInlineInstances).filter(
    ([, info]) => candidateClassNames.has(info.className),
  );
  const resolveInlineMethodSignature = (): {
    className: string;
    returnType: TypeSymbol;
  } | null => {
    for (const className of candidateClassNames) {
      if (converter.classRegistry?.getClass(className)) {
        const method = converter.classRegistry
          .getMergedMethods(className)
          .find((candidate) => candidate.name === propAccess.property);
        if (method) {
          return {
            className,
            returnType: converter.typeMapper.mapTypeScriptType(
              method.returnType,
            ),
          };
        }
      }
      const classNode = converter.classMap.get(className);
      const method = classNode?.methods.find(
        (candidate) => candidate.name === propAccess.property,
      );
      if (method) {
        return { className, returnType: method.returnType };
      }
    }
    return null;
  };

  if (
    candidateInstances.length === 0 ||
    candidateInstances.length > MAX_UNTRACKED_DISPATCH_CANDIDATES
  ) {
    return null;
  }

  const methodSignature = resolveInlineMethodSignature();
  if (!methodSignature) return null;
  const untrackedReturnType = methodSignature.returnType;
  const resolvedUntrackedReturnType = untrackedReturnType?.name
    ? (converter.typeMapper.getAlias(untrackedReturnType.name) ??
      untrackedReturnType)
    : untrackedReturnType;
  const isVoid =
    resolvedUntrackedReturnType?.name === "SystemVoid" ||
    resolvedUntrackedReturnType?.name === "void";
  if (!resolvedUntrackedReturnType) return null;

  const savedInstructionCount = converter.instructions.length;
  const savedTempCounter = converter.tempCounter;
  const savedLabelCounter = converter.labelCounter;
  const savedInlineInstanceMap = new Map(converter.inlineInstanceMap);
  const savedAllInlineInstances = new Map(converter.allInlineInstances);
  let dispatchFailed = false;
  const typedArgs = evaluateArgsWithExpectedTypes(
    converter,
    methodSignature.className,
    propAccess.property,
    rawArgs,
  );
  const dispatchArgs = typedArgs ?? evaluatedArgs;

  const dispatchResult = isVoid
    ? undefined
    : converter.newTemp(resolvedUntrackedReturnType);
  const handleVar = converter.newTemp(PrimitiveTypes.int32);
  converter.instructions.push(new CopyInstruction(handleVar, object));
  const endLabel = converter.newLabel("untracked_call_end");

  // Track inline return info across branches for inline-like return types.
  let resultInlineMapping:
    | { prefix: string; className: string }
    | null
    | undefined;

  for (const [instanceId, info] of candidateInstances) {
    const branchMapSnapshot = new Map(converter.inlineInstanceMap);
    const branchAllInlineSnapshot = new Map(converter.allInlineInstances);
    const nextLabel = converter.newLabel("untracked_call_next");
    const cond = converter.newTemp(PrimitiveTypes.boolean);
    converter.instructions.push(
      new BinaryOpInstruction(
        cond,
        handleVar,
        "==",
        createConstant(instanceId, PrimitiveTypes.int32),
      ),
    );
    converter.instructions.push(
      new ConditionalJumpInstruction(cond, nextLabel),
    );

    const inlineRes = converter.visitInlineInstanceMethodCallWithContext(
      info.className,
      info.prefix,
      propAccess.property,
      dispatchArgs,
    );
    if (!inlineRes) {
      converter.instructions.length = savedInstructionCount;
      converter.tempCounter = savedTempCounter;
      converter.labelCounter = savedLabelCounter;
      converter.inlineInstanceMap = savedInlineInstanceMap;
      converter.allInlineInstances = savedAllInlineInstances;
      dispatchFailed = true;
      break;
    }

    if (dispatchResult) {
      converter.instructions.push(
        new CopyInstruction(dispatchResult, inlineRes),
      );
      resultInlineMapping = mergeInlineMapping(
        resultInlineMapping,
        inlineRes,
        converter.inlineInstanceMap,
      );
    }
    converter.instructions.push(new UnconditionalJumpInstruction(endLabel));
    converter.instructions.push(new LabelInstruction(nextLabel));
    converter.inlineInstanceMap = branchMapSnapshot;
    converter.allInlineInstances = branchAllInlineSnapshot;
  }

  if (dispatchFailed) return null;

  // Miss path: do NOT emit a generic MethodCallInstruction.
  // For erased owners, that would generate invalid EXTERN signatures
  // (e.g. SystemObject.__inc__) and fail VM load.
  converter.inlineInstanceMap = savedInlineInstanceMap;
  converter.allInlineInstances = savedAllInlineInstances;
  const logExtern = converter.requireExternSignature(
    "Debug",
    "LogError",
    "method",
    ["object"],
    "void",
  );
  const missMsg = createConstant(
    `[udon-assembly-ts] Untracked inline method dispatch miss: ${propAccess.property}`,
    PrimitiveTypes.string,
  );
  converter.instructions.push(
    new CallInstruction(undefined, logExtern, [missMsg]),
  );
  converter.instructions.push(new LabelInstruction(endLabel));

  // Propagate inline tracking if all branches agreed.
  if (dispatchResult && resultInlineMapping) {
    converter.inlineInstanceMap.set(
      operandTrackingKey(dispatchResult) ?? "",
      resultInlineMapping,
    );
  }
  return dispatchResult ?? VOID_RETURN;
}

/**
 * D3 method dispatch fallback: when a method call receiver is a Variable or
 * Temporary with a known (or inferable) inline class type but no tracking,
 * dispatch by runtime handle — mirrors D3 property dispatch in expression.ts.
 *
 * This catches cases that `tryUntrackedInlineDispatch` misses, such as when
 * the operand type is erased to ObjectType or DataDictionary, or when the
 * method signature could not be resolved from the candidate set.
 */
function tryD3MethodDispatch(
  converter: ASTToTACConverter,
  object: TACOperand,
  objectType: TypeSymbol,
  propAccess: PropertyAccessExpressionNode,
  rawArgs: ASTNode[],
  evaluatedArgs: TACOperand[],
): TACOperand | null {
  const objectTypeName = objectType.name;
  if (!objectTypeName) return null;

  // Collect candidate instances: match by type name, implementors, or
  // method-name fallback for erased types.
  const dispInstances: Array<[number, { prefix: string; className: string }]> =
    [];

  // Direct type match + interface implementor match
  const implementorNames = getOrPopulateImplementorNames(
    converter,
    objectTypeName,
  );
  for (const [instId, info] of converter.allInlineInstances) {
    if (
      info.className === objectTypeName ||
      implementorNames?.has(info.className)
    ) {
      dispInstances.push([instId, info]);
    }
  }

  // AST type fallback: when operand type is erased, try resolving from AST.
  if (dispInstances.length === 0) {
    const astType = resolveTypeFromNode(converter, propAccess.object);
    const astName = astType?.name;
    if (astName && astName !== objectTypeName) {
      const astImpl = getOrPopulateImplementorNames(converter, astName);
      for (const [instId, info] of converter.allInlineInstances) {
        if (info.className === astName || astImpl?.has(info.className)) {
          dispInstances.push([instId, info]);
        }
      }
      // usedErasedFallback: miss path always emits LogError regardless.
    }
  }

  // Method-name fallback for erased types (ObjectType, DataDictionary):
  // scan inline instances for classes that define the target method.
  if (
    dispInstances.length === 0 &&
    (objectTypeName === "object" || objectTypeName === "DataDictionary")
  ) {
    const candidateClasses = new Set<string>();
    for (const [, info] of converter.allInlineInstances) {
      if (candidateClasses.has(info.className)) continue;
      if (resolveClassMethod(converter, info.className, propAccess.property)) {
        candidateClasses.add(info.className);
      }
    }
    if (candidateClasses.size === 1) {
      for (const [instId, info] of converter.allInlineInstances) {
        if (candidateClasses.has(info.className)) {
          dispInstances.push([instId, info]);
        }
      }
      // usedErasedFallback: miss path always emits LogError regardless.
    } else if (candidateClasses.size > 1) {
      // Multiple classes share this method name. Try narrowing via AST type.
      const astType = resolveTypeFromNode(converter, propAccess.object);
      const astName = astType?.name;
      let narrowed: string | undefined;
      if (astName) {
        if (candidateClasses.has(astName)) {
          narrowed = astName;
        } else {
          // Tie-breaking uses the order returned by
          // getImplementorsOfInterface — the first matching implementor wins.
          const impls =
            converter.classRegistry
              ?.getImplementorsOfInterface(astName)
              .map((i) => i.name) ?? [];
          for (const impl of impls) {
            if (candidateClasses.has(impl)) {
              narrowed = impl;
              break;
            }
          }
        }
      }
      if (narrowed) {
        for (const [instId, info] of converter.allInlineInstances) {
          if (info.className === narrowed) {
            dispInstances.push([instId, info]);
          }
        }
        // usedErasedFallback: miss path always emits LogError regardless.
      }
    }
  }

  if (
    dispInstances.length === 0 ||
    dispInstances.length > MAX_D3_METHOD_DISPATCH_CANDIDATES
  ) {
    return null;
  }

  // Resolve the return type from the first candidate class. For the
  // interface-implementor path all implementors share the same method
  // signature, so the first is representative. For the method-name erased-type
  // fallback, candidateClasses is narrowed to a single class before reaching
  // this point, so divergent return types cannot occur.
  const firstClassName = dispInstances[0][1].className;
  const methodResolved = resolveClassMethod(
    converter,
    firstClassName,
    propAccess.property,
  );
  if (!methodResolved) return null;
  const methodReturnType = methodResolved.method.returnType;
  const resolvedRetType = methodReturnType?.name
    ? (converter.typeMapper.getAlias(methodReturnType.name) ?? methodReturnType)
    : methodReturnType;
  const isVoid =
    resolvedRetType?.name === "SystemVoid" || resolvedRetType?.name === "void";

  // Save state for rollback.
  const savedInstructionCount = converter.instructions.length;
  const savedTempCounter = converter.tempCounter;
  const savedLabelCounter = converter.labelCounter;
  const savedInlineInstanceMap = new Map(converter.inlineInstanceMap);
  const savedAllInlineInstances = new Map(converter.allInlineInstances);
  let dispatchFailed = false;

  // Re-evaluate arguments with expected parameter types so that object
  // literals passed to interface-typed parameters are correctly recognised
  // as inline instances rather than DataDictionary objects.
  const typedArgs = evaluateArgsWithExpectedTypes(
    converter,
    firstClassName,
    propAccess.property,
    rawArgs,
  );
  const dispatchArgs = typedArgs ?? evaluatedArgs;

  const dispatchResult = isVoid
    ? undefined
    : converter.newTemp(resolvedRetType ?? ObjectType);
  const handleVar = converter.newTemp(PrimitiveTypes.int32);
  converter.instructions.push(new CopyInstruction(handleVar, object));
  const endLabel = converter.newLabel("d3_method_end");

  // Track inline return info across branches.
  let resultInlineMapping:
    | { prefix: string; className: string }
    | null
    | undefined;

  for (const [instanceId, info] of dispInstances) {
    const branchMapSnapshot = new Map(converter.inlineInstanceMap);
    const branchAllInlineSnapshot = new Map(converter.allInlineInstances);
    const nextLabel = converter.newLabel("d3_method_next");
    const cond = converter.newTemp(PrimitiveTypes.boolean);
    converter.instructions.push(
      new BinaryOpInstruction(
        cond,
        handleVar,
        "==",
        createConstant(instanceId, PrimitiveTypes.int32),
      ),
    );
    converter.instructions.push(
      new ConditionalJumpInstruction(cond, nextLabel),
    );

    const inlineRes = converter.visitInlineInstanceMethodCallWithContext(
      info.className,
      info.prefix,
      propAccess.property,
      dispatchArgs,
    );
    if (!inlineRes) {
      converter.instructions.length = savedInstructionCount;
      converter.tempCounter = savedTempCounter;
      converter.labelCounter = savedLabelCounter;
      converter.inlineInstanceMap = savedInlineInstanceMap;
      converter.allInlineInstances = savedAllInlineInstances;
      dispatchFailed = true;
      break;
    }

    if (dispatchResult) {
      converter.instructions.push(
        new CopyInstruction(dispatchResult, inlineRes),
      );
      resultInlineMapping = mergeInlineMapping(
        resultInlineMapping,
        inlineRes,
        converter.inlineInstanceMap,
      );
    }
    converter.instructions.push(new UnconditionalJumpInstruction(endLabel));
    converter.instructions.push(new LabelInstruction(nextLabel));
    converter.inlineInstanceMap = branchMapSnapshot;
    converter.allInlineInstances = branchAllInlineSnapshot;
  }

  if (dispatchFailed) return null;

  // Miss path: always emit Debug.LogError so an unmatched handle at runtime
  // produces a visible diagnostic instead of silently returning an
  // uninitialized zero/null result.
  converter.inlineInstanceMap = savedInlineInstanceMap;
  converter.allInlineInstances = savedAllInlineInstances;
  const logExtern = converter.requireExternSignature(
    "Debug",
    "LogError",
    "method",
    ["object"],
    "void",
  );
  const errMsg = createConstant(
    `[udon-assembly-ts] D3 method dispatch miss: ${propAccess.property} on untracked instance`,
    PrimitiveTypes.string,
  );
  converter.instructions.push(
    new CallInstruction(undefined, logExtern, [errMsg]),
  );
  converter.instructions.push(new LabelInstruction(endLabel));

  // Propagate inline tracking if all branches agreed.
  if (dispatchResult && resultInlineMapping) {
    converter.inlineInstanceMap.set(
      operandTrackingKey(dispatchResult) ?? "",
      resultInlineMapping,
    );
  }
  return dispatchResult ?? VOID_RETURN;
}

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

  // super() constructor calls: when inside an inline constructor with a known
  // base class, inline the base class constructor body. Otherwise treat as void.
  if (callee.kind === ASTNodeKind.SuperExpression) {
    if (this.currentInlineBaseClass) {
      const superArgs = rawArgs.map((arg) => this.visitExpression(arg));
      inlineSuperConstructorFromArgs(
        this,
        this.currentInlineBaseClass,
        superArgs,
      );
      const deferredClassName = getCurrentDeferredInitializerClassName(this);
      if (deferredClassName) {
        emitDeferredInlineInitializers(this, deferredClassName);
      }
    }
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
        const paramTypeNamesForAccess = evaluatedArgs.map(
          (arg) => this.getOperandType(arg)?.name ?? "Object",
        );
        const externSig = this.resolveStaticExtern(
          objectName,
          access.property,
          "method",
          paramTypeNamesForAccess,
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
    if (calleeName === "String") {
      const evaluatedArgs = getArgs();
      if (evaluatedArgs.length === 0) {
        return createConstant("", PrimitiveTypes.string);
      }
      if (evaluatedArgs.length !== 1) {
        throw new Error("String(...) expects one argument.");
      }
      const arg = evaluatedArgs[0];
      const argType = this.getOperandType(arg);
      if (argType.udonType === UdonType.String) {
        return arg;
      }
      const result = this.newTemp(PrimitiveTypes.string);
      this.instructions.push(
        new MethodCallInstruction(result, arg, "ToString", []),
      );
      return result;
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

        // Float-typed constant whose value is a whole number (e.g., 5.0).
        // Handled separately from isNumericLength (integer types) because
        // TypeScript number literals default to Single/Double in Udon.
        const isWholeFloatConstant =
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

        if (!isNumericLength && !isWholeFloatConstant) {
          const token = this.wrapDataToken(argOperand);
          this.instructions.push(
            new MethodCallInstruction(undefined, listResult, "Add", [token]),
          );
        } else if (node.typeArguments?.[0]) {
          // Pre-populate DataList with N default elements for typed Array<T>(N).
          // NOTE: Only constant-length arrays are pre-populated. Runtime-length
          // arrays (e.g., new Array<number>(someVar)) result in an empty DataList
          // and subsequent indexed access will fail at runtime.
          let count = 0;
          if (isWholeFloatConstant) {
            count = (argOperand as ConstantOperand).value as number;
          } else if (
            isNumericLength &&
            argOperand.kind === TACOperandKind.Constant
          ) {
            count = (argOperand as ConstantOperand).value as number;
          } else if (isNumericLength) {
            // Runtime-length Array<T>(n) cannot be pre-populated at compile time.
            // The resulting empty DataList would silently produce wrong values at runtime,
            // so we abort compilation with a clear error message.
            throw new Error(
              "[udon-assembly-ts] new Array<T>(n) with a runtime-length variable " +
                "cannot be pre-populated. Use a constant length or build the array with a loop.",
            );
          }
          const MAX_ARRAY_PREPOPULATE = 1024;
          if (count > MAX_ARRAY_PREPOPULATE) {
            throw new Error(
              `[udon-assembly-ts] new Array<T>(${count}) exceeds the pre-population limit of ${MAX_ARRAY_PREPOPULATE}. ` +
                "Use a smaller constant or build the array with a loop.",
            );
          }
          if (count > 0) {
            // Choose a type-appropriate zero/default value.
            let defaultVal: number | string | boolean | bigint;
            if (
              arrayType.udonType === UdonType.Int64 ||
              arrayType.udonType === UdonType.UInt64
            ) {
              defaultVal = 0n;
            } else if (isNumericUdonType(arrayType.udonType)) {
              defaultVal = 0;
            } else if (arrayType.udonType === UdonType.String) {
              defaultVal = "";
            } else if (arrayType.udonType === UdonType.Boolean) {
              defaultVal = false;
            } else {
              throw new Error(
                `[udon-assembly-ts] new Array<T>(N) pre-population is only supported for numeric, string, and boolean element types. Got: ${arrayType.name}. ` +
                  "Use a loop to initialise arrays of reference or struct types.",
              );
            }
            const defaultValue = createConstant(defaultVal, arrayType);
            const defaultToken = this.wrapDataToken(defaultValue);
            for (let i = 0; i < count; i++) {
              this.instructions.push(
                new MethodCallInstruction(undefined, listResult, "Add", [
                  defaultToken,
                ]),
              );
            }
          }
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
    if (node.isNew) {
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

    // Inline constant array .includes() optimization:
    // [literal1, literal2, ...].includes(x) → x === literal1 || x === literal2 || ...
    if (
      propAccess.property === "includes" &&
      propAccess.object.kind === ASTNodeKind.ArrayLiteralExpression &&
      node.arguments.length === 1
    ) {
      const arrayNode = propAccess.object as ArrayLiteralExpressionNode;
      const allLiterals = arrayNode.elements.every(
        (e) => e.kind === "element" && e.value.kind === ASTNodeKind.Literal,
      );
      if (allLiterals && arrayNode.elements.length > 0) {
        const arg = this.visitExpression(node.arguments[0]);
        const literals = arrayNode.elements.map((e) =>
          this.visitLiteral(
            (e as { kind: "element"; value: LiteralNode }).value,
          ),
        );
        // First comparison (use "==" since Udon has no strict equality)
        let accumulator = this.newTemp(PrimitiveTypes.boolean);
        this.instructions.push(
          new BinaryOpInstruction(accumulator, arg, "==", literals[0]),
        );
        // Chain remaining with bitwise OR — Udon has no logical-OR BinaryOp;
        // `||` is lowered via conditional jumps (visitShortCircuitOr), but `|`
        // on booleans produces the same result without branch overhead.
        for (let i = 1; i < literals.length; i++) {
          const cmp = this.newTemp(PrimitiveTypes.boolean);
          this.instructions.push(
            new BinaryOpInstruction(cmp, arg, "==", literals[i]),
          );
          const newAcc = this.newTemp(PrimitiveTypes.boolean);
          this.instructions.push(
            new BinaryOpInstruction(newAcc, accumulator, "|", cmp),
          );
          accumulator = newAcc;
        }
        return accumulator;
      }
    }

    const object = this.visitExpression(propAccess.object);
    const objectType = this.getOperandType(object);
    const resolvedType = resolveTypeFromNode(this, propAccess.object);
    const setType = isSetCollectionType(objectType)
      ? objectType
      : isSetCollectionType(resolvedType)
        ? resolvedType
        : null;
    // Prefer resolvedType when it carries richer generic info (keyType/valueType)
    // than objectType. This covers ExternTypeSymbol (no valueType at all) and
    // CollectionTypeSymbol with erased generics (valueType === undefined).
    let mapType: TypeSymbol | null = null;
    if (isMapCollectionType(objectType)) {
      const objectLacksGenerics =
        !(objectType instanceof CollectionTypeSymbol) ||
        objectType.valueType === undefined ||
        objectType.valueType === ObjectType;
      mapType =
        objectLacksGenerics &&
        resolvedType instanceof CollectionTypeSymbol &&
        isMapCollectionType(resolvedType)
          ? resolvedType
          : objectType;
    } else if (isMapCollectionType(resolvedType)) {
      mapType = resolvedType;
    }
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

    // WS-2: Set currentExpectedType for object literal arguments to inline methods.
    // Detect inline method calls before getArgs() so that ObjectLiteralExpression
    // arguments are evaluated with the parameter's InterfaceTypeSymbol, producing
    // inline heap variables instead of a DataDictionary.
    if (!args) {
      const inlineClassName = resolveInlineClassName(this, propAccess, object);
      if (inlineClassName) {
        args = evaluateArgsWithExpectedTypes(
          this,
          inlineClassName,
          propAccess.property,
          rawArgs,
        );
      }
    }

    // For array.push() with object literal arguments, propagate the array's
    // element type so object literals are recognized as typed inline instances.
    if (
      !args &&
      propAccess.property === "push" &&
      rawArgs.some((a) => a.kind === ASTNodeKind.ObjectLiteralExpression)
    ) {
      const arrType = this.getOperandType(object);
      let elemType: TypeSymbol | undefined;
      if (arrType instanceof ArrayTypeSymbol) {
        elemType = arrType.elementType;
      }
      // Also try AST-based resolution when operand type has erased element type
      if (!elemType || elemType === ObjectType) {
        const resolved = resolveTypeFromNode(this, propAccess.object);
        if (resolved instanceof ArrayTypeSymbol) {
          elemType = resolved.elementType;
        }
      }
      if (
        elemType instanceof InterfaceTypeSymbol &&
        elemType.properties.size > 0
      ) {
        args = rawArgs.map((arg) => {
          if (arg.kind === ASTNodeKind.ObjectLiteralExpression) {
            const prev = this.currentExpectedType;
            this.currentExpectedType = elemType;
            try {
              return this.visitExpression(arg);
            } finally {
              this.currentExpectedType = prev;
            }
          }
          return this.visitExpression(arg);
        });
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
      const paramTypeNames = evaluatedArgs.map(
        (arg) => this.getOperandType(arg)?.name ?? "Object",
      );
      const externSig = this.resolveStaticExtern(
        (propAccess.object as IdentifierNode).name,
        propAccess.property,
        "method",
        paramTypeNames,
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
      const objectType = this.getOperandType(object);
      // Strings use "Length"; arrays (backed by DataList) use "Count".
      const lengthProp =
        objectType === PrimitiveTypes.string ? "Length" : "Count";
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
      // typeId is always 0 — UdonSharp's runtime resolves types internally
      // and our computed hash would not match.
      const typeOperand = createConstant(0n, PrimitiveTypes.int64);
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
      const layout =
        this.getUdonBehaviourLayout(objectType.name)?.get(
          propAccess.property,
        ) ??
        buildFallbackMethodLayout(this, objectType.name, propAccess.property);
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
    if (
      objectType.name === ExternTypes.dataList.name ||
      objectType instanceof DataListTypeSymbol ||
      objectType.udonType === UdonType.DataList
    ) {
      if (propAccess.property === "Add" && evaluatedArgs.length === 1) {
        const token = this.wrapDataToken(evaluatedArgs[0]);
        this.instructions.push(
          new MethodCallInstruction(undefined, object, "Add", [token]),
        );
        return VOID_RETURN;
      }
      if (propAccess.property === "push") {
        if (evaluatedArgs.length === 0) {
          // push() with no args: no mutation, return current count
          const countResult = this.newTemp(PrimitiveTypes.int32);
          this.instructions.push(
            new PropertyGetInstruction(countResult, object, "Count"),
          );
          return countResult;
        }
        // DataList.push(value) → DataList.Add(wrapDataToken(value)) for each arg
        for (const arg of evaluatedArgs) {
          const token = this.wrapDataToken(arg);
          this.instructions.push(
            new MethodCallInstruction(undefined, object, "Add", [token]),
          );
        }
        const countResult = this.newTemp(PrimitiveTypes.int32);
        this.instructions.push(
          new PropertyGetInstruction(countResult, object, "Count"),
        );
        return countResult;
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
    // String.prototype.slice → Substring with parameter adjustment
    if (
      objectType === PrimitiveTypes.string &&
      propAccess.property === "slice"
    ) {
      const result = this.newTemp(PrimitiveTypes.string);
      const isNegConst = (op: TACOperand): boolean =>
        op.kind === TACOperandKind.Constant &&
        Number((op as ConstantOperand).value) < 0;
      // Ensure argument is Int32 (Substring expects SystemInt32)
      const toInt32 = (op: TACOperand): TACOperand => {
        const cast = this.newTemp(PrimitiveTypes.int32);
        this.instructions.push(new CastInstruction(cast, op));
        return cast;
      };
      // Adjust a negative constant index: length + index
      const adjustNegIndex = (arg: TACOperand): TACOperand => {
        const lenTemp = this.newTemp(PrimitiveTypes.int32);
        // Strings use "Length", not "Count" (which is DataList-only).
        this.instructions.push(
          new PropertyGetInstruction(lenTemp, object, "Length"),
        );
        const adjusted = this.newTemp(PrimitiveTypes.int32);
        this.instructions.push(
          new BinaryOpInstruction(adjusted, lenTemp, "+", toInt32(arg)),
        );
        return adjusted;
      };
      // Convert an index arg to Int32, adjusting negative constants
      const resolveIndex = (arg: TACOperand): TACOperand =>
        isNegConst(arg) ? adjustNegIndex(arg) : toInt32(arg);

      if (evaluatedArgs.length === 1) {
        const startInt = resolveIndex(evaluatedArgs[0]);
        this.instructions.push(
          new MethodCallInstruction(result, object, "Substring", [startInt]),
        );
      } else if (evaluatedArgs.length === 2) {
        // NOTE: JS-style clamping (end > length → clamp, end < start → return "")
        // is NOT emitted. Callers must ensure 0 ≤ start ≤ end ≤ string.length.
        const startInt = resolveIndex(evaluatedArgs[0]);
        const endInt = resolveIndex(evaluatedArgs[1]);
        const lengthArg = this.newTemp(PrimitiveTypes.int32);
        this.instructions.push(
          new BinaryOpInstruction(lengthArg, endInt, "-", startInt),
        );
        this.instructions.push(
          new MethodCallInstruction(result, object, "Substring", [
            startInt,
            lengthArg,
          ]),
        );
      } else {
        // slice() with 0 args is a TS type-error; 3+ args can't happen via the stub.
        // Emit a best-effort call and let the assembler surface the error.
        this.instructions.push(
          new MethodCallInstruction(
            result,
            object,
            "Substring",
            evaluatedArgs.map((a) => toInt32(a)),
          ),
        );
      }
      return result;
    }
    if (objectType.udonType === UdonType.Array) {
      const arrayReturn =
        objectType instanceof ArrayTypeSymbol
          ? objectType
          : new ArrayTypeSymbol(ObjectType);
      switch (propAccess.property) {
        case "concat": {
          // Udon VM does not have a native Array.concat extern.
          // Implement as loop-based copy via DataList.
          if (evaluatedArgs.length === 0) {
            // arr.concat() → shallow copy via concat with empty DataList
            const emptyList = this.newTemp(ExternTypes.dataList);
            const ctorExtern = this.requireExternSignature(
              "DataList",
              "ctor",
              "method",
              [],
              "DataList",
            );
            this.instructions.push(
              new CallInstruction(emptyList, ctorExtern, []),
            );
            return emitArrayConcat(this, object, emptyList);
          }
          let result = object;
          for (const arg of evaluatedArgs) {
            // JS concat flattens arrays but wraps scalars. Check if the
            // argument is an array/DataList; if not, wrap it in a
            // single-element DataList before concatenating.
            const argType = this.getOperandType(arg);
            const isArray =
              argType instanceof ArrayTypeSymbol ||
              argType instanceof DataListTypeSymbol ||
              argType.name === ExternTypes.dataList.name ||
              argType.udonType === UdonType.Array ||
              argType.udonType === UdonType.DataList;
            if (isArray) {
              result = emitArrayConcat(this, result, arg);
            } else {
              // Wrap scalar in a single-element DataList.
              const wrapperCtorSig = this.requireExternSignature(
                "DataList",
                "ctor",
                "method",
                [],
                "DataList",
              );
              const wrapper = this.newTemp(
                new DataListTypeSymbol(this.getOperandType(arg)),
              );
              this.instructions.push(
                new CallInstruction(wrapper, wrapperCtorSig, []),
              );
              const token = this.wrapDataToken(arg);
              this.instructions.push(
                new MethodCallInstruction(undefined, wrapper, "Add", [token]),
              );
              result = emitArrayConcat(this, result, wrapper);
            }
          }
          return result;
        }
        case "slice": {
          // JS slice(start, end) → DataList.GetRange(start, end - start)
          const result = this.newTemp(arrayReturn);
          const coerceToInt32 = (operand: TACOperand): TACOperand => {
            const operandType = this.getOperandType(operand);
            if (!needsInt32IndexCoercion(operandType.udonType)) {
              return operand;
            }
            const casted = this.newTemp(PrimitiveTypes.int32);
            this.instructions.push(new CastInstruction(casted, operand));
            return casted;
          };
          if (evaluatedArgs.length === 0) {
            // slice() = copy entire list → GetRange(0, Count)
            const len = this.newTemp(PrimitiveTypes.int32);
            this.instructions.push(
              new PropertyGetInstruction(len, object, "Count"),
            );
            this.instructions.push(
              new MethodCallInstruction(result, object, "GetRange", [
                createConstant(0, PrimitiveTypes.int32),
                len,
              ]),
            );
          } else if (evaluatedArgs.length === 1) {
            // slice(start) → GetRange(start, Count - start)
            const start = coerceToInt32(evaluatedArgs[0]);
            const len = this.newTemp(PrimitiveTypes.int32);
            this.instructions.push(
              new PropertyGetInstruction(len, object, "Count"),
            );
            const count = this.newTemp(PrimitiveTypes.int32);
            this.instructions.push(
              new BinaryOpInstruction(count, len, "-", start),
            );
            this.instructions.push(
              new MethodCallInstruction(result, object, "GetRange", [
                start,
                count,
              ]),
            );
          } else {
            // slice(start, end) → GetRange(start, end - start)
            const start = coerceToInt32(evaluatedArgs[0]);
            const end = coerceToInt32(evaluatedArgs[1]);
            const count = this.newTemp(PrimitiveTypes.int32);
            this.instructions.push(
              new BinaryOpInstruction(count, end, "-", start),
            );
            this.instructions.push(
              new MethodCallInstruction(result, object, "GetRange", [
                start,
                count,
              ]),
            );
          }
          return result;
        }
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
          if (evaluatedArgs.length < 1) {
            return createConstant(false, PrimitiveTypes.boolean);
          }
          const searchValue = evaluatedArgs[0];
          const result = this.newTemp(PrimitiveTypes.boolean);
          this.instructions.push(
            new AssignmentInstruction(
              result,
              createConstant(false, PrimitiveTypes.boolean),
            ),
          );
          const indexVar = this.newTemp(PrimitiveTypes.int32);
          this.instructions.push(
            new AssignmentInstruction(
              indexVar,
              createConstant(0, PrimitiveTypes.int32),
            ),
          );
          const lenVar = this.newTemp(PrimitiveTypes.int32);
          this.instructions.push(
            new PropertyGetInstruction(lenVar, object, "Count"),
          );
          const loopStart = this.newLabel("includes_start");
          const loopEnd = this.newLabel("includes_end");
          this.instructions.push(new LabelInstruction(loopStart));
          // if !(i < len) goto end
          const condVar = this.newTemp(PrimitiveTypes.boolean);
          this.instructions.push(
            new BinaryOpInstruction(condVar, indexVar, "<", lenVar),
          );
          this.instructions.push(
            new ConditionalJumpInstruction(condVar, loopEnd),
          );
          // elem = DataList.get_Item(i) → unwrap
          const elemType =
            objectType instanceof ArrayTypeSymbol
              ? objectType.elementType
              : ObjectType;
          const tokenTemp = this.newTemp(ExternTypes.dataToken);
          this.instructions.push(
            new MethodCallInstruction(tokenTemp, object, "get_Item", [
              indexVar,
            ]),
          );
          const elem = this.unwrapDataToken(tokenTemp, elemType);
          // if (elem == value) { result = true; goto end }
          const eqVar = this.newTemp(PrimitiveTypes.boolean);
          this.instructions.push(
            new BinaryOpInstruction(eqVar, elem, "==", searchValue),
          );
          const nextLabel = this.newLabel("includes_no_match");
          this.instructions.push(
            new ConditionalJumpInstruction(eqVar, nextLabel),
          );
          this.instructions.push(
            new AssignmentInstruction(
              result,
              createConstant(true, PrimitiveTypes.boolean),
            ),
          );
          this.instructions.push(new UnconditionalJumpInstruction(loopEnd));
          this.instructions.push(new LabelInstruction(nextLabel));
          // i = i + 1
          const nextIndex = this.newTemp(PrimitiveTypes.int32);
          this.instructions.push(
            new BinaryOpInstruction(
              nextIndex,
              indexVar,
              "+",
              createConstant(1, PrimitiveTypes.int32),
            ),
          );
          this.instructions.push(
            new AssignmentInstruction(indexVar, nextIndex),
          );
          this.instructions.push(new UnconditionalJumpInstruction(loopStart));
          this.instructions.push(new LabelInstruction(loopEnd));
          return result;
        }
        case "join": {
          const result = this.newTemp(PrimitiveTypes.string);
          this.instructions.push(
            new MethodCallInstruction(result, object, "join", evaluatedArgs),
          );
          return result;
        }
        case "push": {
          // push() with no args: return current length without mutation
          if (evaluatedArgs.length === 0) {
            const curLen = this.newTemp(PrimitiveTypes.int32);
            this.instructions.push(
              new PropertyGetInstruction(curLen, object, "Count"),
            );
            return curLen;
          }

          // Current lowering policy: TS arrays use DataList; push = Add(token).
          for (const arg of evaluatedArgs) {
            const token = this.wrapDataToken(arg);
            this.instructions.push(
              new MethodCallInstruction(undefined, object, "Add", [token]),
            );
          }

          // Return new length (push returns the new array length)
          const newLen = this.newTemp(PrimitiveTypes.int32);
          this.instructions.push(
            new PropertyGetInstruction(newLen, object, "Count"),
          );
          return newLen;
        }
        case "splice": {
          // splice(start, deleteCount, ...items) → remove and optionally insert
          // Udon arrays are fixed-size, so we build a new array:
          //   left  = array.slice(0, start)
          //   removed = array.slice(start, start + deleteCount)
          //   right = array.slice(start + deleteCount)
          //   [if items] insertArr = new T[items.length]; fill; mid = insertArr
          //   newArr = left.concat(mid?).concat(right)
          //   array = newArr
          //   return removed
          // Build a local args list. Per JS spec:
          //   splice()      = splice(0, length) — remove all elements
          //   splice(start) = splice(start, length - start) — remove from start
          let spliceArgs: TACOperand[];
          if (evaluatedArgs.length < 2) {
            const spliceStart =
              evaluatedArgs.length === 0
                ? createConstant(0, PrimitiveTypes.int32)
                : evaluatedArgs[0];
            const arrLen = this.newTemp(PrimitiveTypes.int32);
            this.instructions.push(
              new PropertyGetInstruction(arrLen, object, "Count"),
            );
            const computedDeleteCount = this.newTemp(PrimitiveTypes.int32);
            this.instructions.push(
              new BinaryOpInstruction(
                computedDeleteCount,
                arrLen,
                "-",
                spliceStart,
              ),
            );
            spliceArgs = [spliceStart, computedDeleteCount];
          } else {
            spliceArgs = evaluatedArgs;
          }
          const start = spliceArgs[0];
          const deleteCount = spliceArgs[1];
          const insertItems = spliceArgs.slice(2);

          // endIdx = start + deleteCount
          const endIdx = this.newTemp(PrimitiveTypes.int32);
          this.instructions.push(
            new BinaryOpInstruction(endIdx, start, "+", deleteCount),
          );

          const zero = createConstant(0, PrimitiveTypes.int32);

          // left = array.GetRange(0, start)
          const leftPart = this.newTemp(arrayReturn);
          this.instructions.push(
            new MethodCallInstruction(leftPart, object, "GetRange", [
              zero,
              start,
            ]),
          );

          // removed = array.GetRange(start, deleteCount)
          const removed = this.newTemp(arrayReturn);
          this.instructions.push(
            new MethodCallInstruction(removed, object, "GetRange", [
              start,
              deleteCount,
            ]),
          );

          // right = array.GetRange(endIdx, length - endIdx)
          const spliceLen = this.newTemp(PrimitiveTypes.int32);
          this.instructions.push(
            new PropertyGetInstruction(spliceLen, object, "Count"),
          );
          const rightCount = this.newTemp(PrimitiveTypes.int32);
          this.instructions.push(
            new BinaryOpInstruction(rightCount, spliceLen, "-", endIdx),
          );
          const rightPart = this.newTemp(arrayReturn);
          this.instructions.push(
            new MethodCallInstruction(rightPart, object, "GetRange", [
              endIdx,
              rightCount,
            ]),
          );

          let combined = leftPart;

          // If there are items to insert, build an insert DataList
          if (insertItems.length > 0) {
            const elemType =
              objectType instanceof ArrayTypeSymbol
                ? objectType.elementType
                : ObjectType;
            const insertList = this.newTemp(new DataListTypeSymbol(elemType));
            const insertCtorSig = this.requireExternSignature(
              "DataList",
              "ctor",
              "method",
              [],
              "DataList",
            );
            this.instructions.push(
              new CallInstruction(insertList, insertCtorSig, []),
            );
            for (const item of insertItems) {
              const token = this.wrapDataToken(item);
              this.instructions.push(
                new MethodCallInstruction(undefined, insertList, "Add", [
                  token,
                ]),
              );
            }
            combined = emitArrayConcat(this, leftPart, insertList);
          }

          // newArr = combined.concat(right)
          const newArr = emitArrayConcat(this, combined, rightPart);

          // Write back new array reference to original variable.
          // Only Variable operands (locals, inline class fields) can be
          // updated persistently. Temporary operands originate from
          // PropertyGet and writing to them would not propagate back to
          // the source property.
          if (object.kind === TACOperandKind.Variable) {
            this.instructions.push(new CopyInstruction(object, newArr));
          }

          return removed;
        }
      }
    }

    // Iterator .next() on DataList: translate to get_Item(0) returning DataToken.
    // Only supports the single-shot `map.keys().next().value` idiom — repeated
    // .next() calls will always return the first element.
    // The returned DataToken is unwrapped by the `.value` handler in
    // visitPropertyAccessExpression. For primitive-typed keys (int, float),
    // .Reference returns null — only string/reference-type keys are supported.
    if (
      propAccess.property === "next" &&
      evaluatedArgs.length === 0 &&
      (objectType instanceof DataListTypeSymbol ||
        objectType.name === ExternTypes.dataList.name ||
        objectType.udonType === UdonType.DataList)
    ) {
      const tokenResult = this.newTemp(ExternTypes.dataToken);
      this.instructions.push(
        new MethodCallInstruction(tokenResult, object, "get_Item", [
          createConstant(0, PrimitiveTypes.int32),
        ]),
      );
      return tokenResult;
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
    // Inline context self-method: this.method() inside inline class body
    if (
      propAccess.object.kind === ASTNodeKind.ThisExpression &&
      this.currentInlineContext &&
      !this.currentThisOverride
    ) {
      const inlineResult = this.visitInlineInstanceMethodCallWithContext(
        this.currentInlineContext.className,
        this.currentInlineContext.instancePrefix,
        propAccess.property,
        evaluatedArgs,
      );
      if (inlineResult != null) return inlineResult;
    }
    // Inline instance method call: object.method() where object is inline instance.
    // operandTrackingKey handles both Variable and Temporary operands.
    const methodInstanceKey = operandTrackingKey(object);
    if (methodInstanceKey) {
      const instanceInfo = this.resolveInlineInstance(methodInstanceKey);
      if (instanceInfo) {
        const inlineResult = this.visitInlineInstanceMethodCallWithContext(
          instanceInfo.className,
          instanceInfo.prefix,
          propAccess.property,
          evaluatedArgs,
        );
        if (inlineResult != null) return inlineResult;

        // When className is an interface/type alias, resolve to the concrete
        // class via allInlineInstances and retry. This handles cases where
        // copy tracking or saveAndBindInlineParams stored the interface name
        // instead of the concrete class name.
        const concreteClass = resolveConcreteClassName(this, instanceInfo);
        if (concreteClass !== instanceInfo.className) {
          const concreteResult = this.visitInlineInstanceMethodCallWithContext(
            concreteClass,
            instanceInfo.prefix,
            propAccess.property,
            evaluatedArgs,
          );
          if (concreteResult != null) return concreteResult;
        }

        // Interface classId-based dispatch: when className is an interface
        // with all-inline implementors, dispatch by classId.
        // The isAllInlineInterface guard prevents mixed-implementor interfaces
        // (some inline, some UdonBehaviour) from entering this path — those
        // must fall through to the EXTERN/IPC path below.
        const classIds = this.interfaceClassIdMap.get(instanceInfo.className);
        if (
          classIds &&
          classIds.size > 0 &&
          isAllInlineInterface(this, instanceInfo.className)
        ) {
          const ifaceMeta = this.classRegistry?.getInterface(
            instanceInfo.className,
          );
          const methodMeta = ifaceMeta?.methods.find(
            (m) => m.name === propAccess.property,
          );
          const returnType = methodMeta
            ? this.typeMapper.mapTypeScriptType(methodMeta.returnType)
            : ObjectType;
          const isVoid =
            returnType.name === "SystemVoid" ||
            methodMeta?.returnType === "void";
          // Save state BEFORE allocating any variables so rollback
          // doesn't leave orphaned temps/labels in the TAC variable table.
          const savedInstructionCount = this.instructions.length;
          const savedTempCounter = this.tempCounter;
          const savedLabelCounter = this.labelCounter;
          const savedInlineInstanceMap = new Map(this.inlineInstanceMap);
          const savedAllInlineInstances = new Map(this.allInlineInstances);
          let dispatchFailed = false;

          const result = isVoid
            ? undefined
            : createVariable(`__iface_ret_${this.tempCounter++}`, returnType, {
                isLocal: true,
              });
          const endLabel = this.newLabel("iface_dispatch_end");
          const classIdVar = createVariable(
            `${instanceInfo.prefix}__classId`,
            PrimitiveTypes.int32,
          );
          let resultInlineMapping:
            | { prefix: string; className: string }
            | null
            | undefined;

          for (const [className, classId] of classIds) {
            // Snapshot inlineInstanceMap and allInlineInstances before each
            // branch so side-effects from one implementor's inlined body
            // (e.g. temporaries tracked as inline instances) don't leak into
            // subsequent branches.
            const branchMapSnapshot = new Map(this.inlineInstanceMap);
            const branchAllInlineSnapshot = new Map(this.allInlineInstances);

            const nextLabel = this.newLabel("iface_dispatch_next");
            const cond = this.newTemp(PrimitiveTypes.boolean);
            this.instructions.push(
              new BinaryOpInstruction(
                cond,
                classIdVar,
                "==",
                createConstant(classId, PrimitiveTypes.int32),
              ),
            );
            this.instructions.push(
              new ConditionalJumpInstruction(cond, nextLabel),
            );

            const inlineRes = this.visitInlineInstanceMethodCallWithContext(
              className,
              instanceInfo.prefix,
              propAccess.property,
              evaluatedArgs,
            );
            if (!inlineRes) {
              // Inlining blocked (e.g. recursion guard); roll back the
              // partially emitted dispatch and fall through to the generic
              // EXTERN / UdonBehaviour path.
              this.instructions.length = savedInstructionCount;
              this.tempCounter = savedTempCounter;
              this.labelCounter = savedLabelCounter;
              this.inlineInstanceMap = savedInlineInstanceMap;
              this.allInlineInstances = savedAllInlineInstances;
              dispatchFailed = true;
              break;
            }
            if (result) {
              this.instructions.push(new CopyInstruction(result, inlineRes));
              const inlineMapping =
                inlineRes.kind === TACOperandKind.Variable
                  ? this.inlineInstanceMap.get(
                      (inlineRes as VariableOperand).name,
                    )
                  : undefined;
              // When the return type is a known InterfaceTypeSymbol or inline
              // class and this branch returned a tracked instance of that type,
              // copy each field to a stable per-call-site prefix
              // (result.name_fieldName). This allows the caller to track the
              // result uniformly even when different dispatch branches produce
              // different concrete prefixes.
              if (inlineMapping) {
                let fieldsToCopy: Array<[string, TypeSymbol]> | null = null;
                // For interface return types, always use the interface's
                // property list regardless of the concrete className.
                // This allows different implementors to converge on a single
                // stable prefix with effectiveClassName = returnType.name.
                let effectiveClassName = inlineMapping.className;
                if (
                  returnType instanceof InterfaceTypeSymbol &&
                  returnType.properties.size > 0
                ) {
                  fieldsToCopy = Array.from(
                    returnType.properties.entries(),
                  ).map(
                    ([name, sym]) =>
                      [
                        name,
                        sym.name
                          ? (this.typeMapper.getAlias(sym.name) ?? sym)
                          : sym,
                      ] as [string, TypeSymbol],
                  );
                  effectiveClassName = returnType.name;
                } else {
                  // Use merged class metadata to include inherited properties.
                  if (this.classRegistry) {
                    const mergedProps = this.classRegistry.getMergedProperties(
                      inlineMapping.className,
                    );
                    if (mergedProps.length > 0) {
                      fieldsToCopy = mergedProps.map(
                        (p) =>
                          [
                            p.name,
                            this.typeMapper.mapTypeScriptType(p.type),
                          ] as [string, TypeSymbol],
                      );
                    }
                  } else {
                    const classNode = this.classMap.get(
                      inlineMapping.className,
                    );
                    if (classNode) {
                      fieldsToCopy = classNode.properties
                        .filter((p) => !p.isStatic)
                        .map((p) => {
                          const resolvedType = p.type.name
                            ? (this.typeMapper.getAlias(p.type.name) ?? p.type)
                            : p.type;
                          return [p.name, resolvedType] as [string, TypeSymbol];
                        });
                    }
                  }
                }

                if (
                  fieldsToCopy &&
                  fieldsToCopy.length > 0 &&
                  // All branches must agree on effectiveClassName.
                  (resultInlineMapping === undefined ||
                    (resultInlineMapping !== null &&
                      resultInlineMapping.className === effectiveClassName))
                ) {
                  for (const [propName, propType] of fieldsToCopy) {
                    const srcField = createVariable(
                      `${inlineMapping.prefix}_${propName}`,
                      propType,
                    );
                    const dstField = createVariable(
                      `${result.name}_${propName}`,
                      propType,
                    );
                    this.instructions.push(
                      new CopyInstruction(dstField, srcField),
                    );
                  }
                  resultInlineMapping = {
                    prefix: result.name,
                    className: effectiveClassName,
                  };
                } else if (fieldsToCopy && fieldsToCopy.length > 0) {
                  // className mismatch across branches — invalidate
                  resultInlineMapping = null;
                } else {
                  // No fields to copy — fall back to simple prefix merging.
                  if (resultInlineMapping === undefined) {
                    resultInlineMapping = inlineMapping;
                  } else if (
                    resultInlineMapping &&
                    (resultInlineMapping.prefix !== inlineMapping.prefix ||
                      resultInlineMapping.className !== inlineMapping.className)
                  ) {
                    // Different branches return different concrete prefixes —
                    // we can't merge them into a single tracking entry.
                    // Known limitation: chained calls on the return value
                    // (e.g. item.getChild().doWork()) will fall through to the
                    // generic path if getChild() returns a freshly-constructed
                    // inline instance. The for-of loop variable itself is
                    // unaffected because it dispatches via classId.
                    resultInlineMapping = null;
                  }
                }
              } else {
                resultInlineMapping = null;
              }
            }
            this.instructions.push(new UnconditionalJumpInstruction(endLabel));
            this.instructions.push(new LabelInstruction(nextLabel));

            // Restore maps INSIDE the loop (not after) so each branch starts
            // from the pre-dispatch state. After the loop, resultInlineMapping
            // is re-inserted for result.name if all branches agreed.
            this.inlineInstanceMap = branchMapSnapshot;
            this.allInlineInstances = branchAllInlineSnapshot;
          }

          if (!dispatchFailed) {
            // Post-loop: inlineInstanceMap is equivalent to the pre-dispatch
            // state (savedInlineInstanceMap) because each iteration restores
            // from its own branchMapSnapshot. Only resultInlineMapping (if
            // all branches agreed) is re-inserted for result.name below.
            //
            // If classIdVar is the sentinel (-1) at runtime, no branch
            // matched. This should not happen — every classId assigned in
            // the for-of dispatch has a corresponding branch. If it does,
            // result retains its Udon heap zero-initialised value.
            this.instructions.push(new LabelInstruction(endLabel));
            if (result) {
              if (resultInlineMapping) {
                this.inlineInstanceMap.set(result.name, resultInlineMapping);
              } else {
                this.inlineInstanceMap.delete(result.name);
              }
            }
            return result ?? VOID_RETURN;
          }
          // dispatchFailed: fall through to generic method call path
        }
      } else {
        const untrackedDispatch = tryUntrackedInlineDispatch(
          this,
          object,
          objectType,
          propAccess,
          rawArgs,
          evaluatedArgs,
        );
        if (untrackedDispatch != null) return untrackedDispatch;
      }
    }
    // Recursive self-method call: use JUMP-based mechanism
    if (
      propAccess.object.kind === ASTNodeKind.ThisExpression &&
      this.currentClassName &&
      this.entryPointClasses.has(this.currentClassName)
    ) {
      const classNode = this.classMap.get(this.currentClassName);
      const methodDef = classNode?.methods.find(
        (m) => m.name === propAccess.property,
      );
      if (methodDef?.isRecursive) {
        const layout = this.udonBehaviourLayouts
          ?.get(this.currentClassName)
          ?.get(propAccess.property);
        if (layout) {
          // Register return site in the shared registry (scoped by class + method)
          const returnLabel = this.newLabel("recursive_return") as LabelOperand;
          const registryKey = `${this.currentClassName}.${propAccess.property}`;
          let registry = this.recursiveReturnSites.get(registryKey);
          if (!registry) {
            // Start at index 1 to reserve 0 as a sentinel "no external caller".
            // Udon heap-initializes Int32 to 0, so if the method is invoked
            // directly by the VRC runtime (no compiled caller sets returnSiteIdx),
            // index 0 won't match any dispatch entry and the fallback RETURN fires.
            registry = { sites: [], nextIndex: 1 };
            this.recursiveReturnSites.set(registryKey, registry);
          }
          const returnSiteIdx = registry.nextIndex++;
          registry.sites.push({
            index: returnSiteIdx,
            labelName: returnLabel.name,
          });
          if (this.currentRecursiveContext) {
            this.currentRecursiveContext.returnSites.push({
              index: returnSiteIdx,
              labelName: returnLabel.name,
            });
          }

          if (
            this.currentRecursiveContext &&
            propAccess.property === this.currentMethodName
          ) {
            // === SELF-CALL WITHIN RECURSIVE METHOD ===
            // Order: push FIRST (save caller's state), then set params/returnSiteIdx/depth

            // 1. Push all locals to stack (save caller's current state)
            this.emitCallSitePush();

            // 2. Increment depth so re-entry skips stack allocation
            const depthVarOp = createVariable(
              this.currentRecursiveContext.depthVar,
              PrimitiveTypes.int32,
            );
            const depthInc = this.newTemp(PrimitiveTypes.int32);
            this.instructions.push(
              new BinaryOpInstruction(
                depthInc,
                depthVarOp,
                "+",
                createConstant(1, PrimitiveTypes.int32),
              ),
            );
            this.emitCopyWithTracking(depthVarOp, depthInc);

            // 3. Set parameters for the callee
            for (let i = 0; i < evaluatedArgs.length; i++) {
              const paramExportName = layout.parameterExportNames[i];
              if (paramExportName) {
                const paramVar = createVariable(
                  paramExportName,
                  layout.parameterTypes[i] ?? PrimitiveTypes.single,
                );
                this.emitCopyWithTracking(paramVar, evaluatedArgs[i]);
              }
            }

            // 4. Set return site index for dispatch table.
            // This must come AFTER emitCallSitePush (step 1) because push
            // saves the caller's returnSiteIdx. If we set it first, the
            // callee's index would be pushed instead of the caller's.
            const returnSiteIdxVar = createVariable(
              `__returnSiteIdx_${this.currentClassName}_${propAccess.property}`,
              PrimitiveTypes.int32,
              { isLocal: true },
            );
            this.instructions.push(
              new AssignmentInstruction(
                returnSiteIdxVar,
                createConstant(returnSiteIdx, PrimitiveTypes.int32),
              ),
            );

            // 5. JUMP to method entry
            const methodLabel = createLabel(layout.exportMethodName);
            this.instructions.push(
              new UnconditionalJumpInstruction(methodLabel),
            );

            // 6. Return label (dispatch brings us back here)
            this.instructions.push(new LabelInstruction(returnLabel));

            // 7. Read return value into temp BEFORE pop
            let result: TACOperand = VOID_RETURN;
            let capturedTemp: TACOperand | undefined;
            if (layout.returnExportName) {
              const retVar = createVariable(
                layout.returnExportName,
                layout.returnType,
              );
              capturedTemp = this.newTemp(layout.returnType);
              this.emitCopyWithTracking(capturedTemp, retVar);
            }

            // 8. Pop all locals from stack (restore caller's state)
            this.emitCallSitePop();

            // 9. Copy captured result into a named selfCallResult variable
            //    that is part of the push/pop set (survives sibling calls)
            if (capturedTemp && layout.returnExportName) {
              const selfCallIdx =
                this.currentRecursiveContext.nextSelfCallResultIndex ?? 0;
              this.currentRecursiveContext.nextSelfCallResultIndex =
                selfCallIdx + 1;
              const selfCallResultVar = createVariable(
                `__selfCallResult_${this.currentClassName}_${propAccess.property}_${selfCallIdx}`,
                layout.returnType,
                { isLocal: true },
              );
              this.emitCopyWithTracking(selfCallResultVar, capturedTemp);
              result = selfCallResultVar;
            }

            return result;
          }

          // === EXTERNAL CALL (non-recursive caller, or cross-method call) ===
          // This path handles non-recursive methods (Start, OnInteract) calling
          // a recursive method. No push/pop needed: the caller's locals are not
          // affected by the callee's recursion stacks.
          // NOTE: Cross-recursive calls (recursive method A calling recursive
          // method B, or mutual recursion A↔B) are NOT supported. The dispatch
          // table is emitted when B is compiled, so A's return site would not
          // be registered if A is compiled after B. Non-recursive callers are
          // always compiled first (method ordering guarantees this).

          // Set parameters
          for (let i = 0; i < evaluatedArgs.length; i++) {
            const paramExportName = layout.parameterExportNames[i];
            if (paramExportName) {
              const paramVar = createVariable(
                paramExportName,
                layout.parameterTypes[i] ?? PrimitiveTypes.single,
              );
              this.emitCopyWithTracking(paramVar, evaluatedArgs[i]);
            }
          }
          // Set return site index.
          // NOTE: currentClassName is used here as the callee's class name.
          // This is correct because recursive dispatch only supports same-class
          // calls (this.method() form). Cross-class recursive calls are not supported.
          const returnSiteIdxVar = createVariable(
            `__returnSiteIdx_${this.currentClassName}_${propAccess.property}`,
            PrimitiveTypes.int32,
            { isLocal: true },
          );
          this.instructions.push(
            new AssignmentInstruction(
              returnSiteIdxVar,
              createConstant(returnSiteIdx, PrimitiveTypes.int32),
            ),
          );
          // Initialize recursion depth to 0
          const depthVar = createVariable(
            `__recursionDepth_${this.currentClassName}_${propAccess.property}`,
            PrimitiveTypes.int32,
          );
          this.emitCopyWithTracking(
            depthVar,
            createConstant(0, PrimitiveTypes.int32),
          );
          // JUMP to method entry
          const methodLabel = createLabel(layout.exportMethodName);
          this.instructions.push(new UnconditionalJumpInstruction(methodLabel));
          // Return label (dispatch brings us back here)
          this.instructions.push(new LabelInstruction(returnLabel));
          // Reset returnSiteIdx to 0 (sentinel) after dispatch returns here.
          // Without this, a subsequent VRC direct call (SendCustomEvent) would
          // see the stale index and dispatch back to this caller's return label.
          this.instructions.push(
            new AssignmentInstruction(
              returnSiteIdxVar,
              createConstant(0, PrimitiveTypes.int32),
            ),
          );
          // Read return value
          let result: TACOperand = VOID_RETURN;
          if (layout.returnExportName) {
            const retVar = createVariable(
              layout.returnExportName,
              layout.returnType,
            );
            result = this.newTemp(layout.returnType);
            this.emitCopyWithTracking(result, retVar);
          }
          return result;
        }
      }
    }
    // Entry point class self-method: inline the body
    if (
      propAccess.object.kind === ASTNodeKind.ThisExpression &&
      this.currentClassName &&
      this.entryPointClasses.has(this.currentClassName) &&
      !this.currentInlineContext &&
      !this.currentThisOverride
    ) {
      const inlineResult = this.visitInlineInstanceMethodCall(
        this.currentClassName,
        propAccess.property,
        evaluatedArgs,
      );
      if (inlineResult != null) return inlineResult;
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

    // Consult type metadata registry for extern/stub types (overload-aware)
    if (!resolvedReturnType) {
      const overloads = typeMetadataRegistry.getMemberOverloads(
        objectType.name,
        propAccess.property,
      );
      if (
        overloads.length === 1 &&
        overloads[0].paramCsharpTypes.length === evaluatedArgs.length
      ) {
        resolvedReturnType =
          mapCSharpTypeToTypeSymbol(overloads[0].returnCsharpType) ?? null;
      } else if (overloads.length > 1) {
        const mappedArgTypes = evaluatedArgs.map((arg) =>
          mapTypeScriptToCSharp(this.getOperandType(arg).name),
        );
        let bestScore = -1;
        let bestMeta: (typeof overloads)[number] | undefined;
        for (const member of overloads) {
          if (member.paramCsharpTypes.length !== mappedArgTypes.length)
            continue;
          let score = 0;
          let matched = true;
          for (let i = 0; i < member.paramCsharpTypes.length; i++) {
            if (member.paramCsharpTypes[i] === mappedArgTypes[i]) {
              score += 2;
            } else if (member.paramCsharpTypes[i] === "System.Object") {
              // Parameter accepts any type (weaker match)
              score += 1;
            } else if (mappedArgTypes[i] === "System.Object") {
              // Argument type is unknown/widened — don't bias scoring,
              // just allow the match without adding score
            } else {
              matched = false;
              break;
            }
          }
          if (matched && score > bestScore) {
            bestScore = score;
            bestMeta = member;
          }
        }
        if (bestMeta && bestScore > 0) {
          resolvedReturnType =
            mapCSharpTypeToTypeSymbol(bestMeta.returnCsharpType) ?? null;
        } else if (bestMeta && evaluatedArgs.length === 0) {
          // Zero-arg call: only resolve if exactly one 0-param overload exists,
          // otherwise the selection is ambiguous.
          const zeroParamCount = overloads.filter(
            (o) => o.paramCsharpTypes.length === 0,
          ).length;
          if (zeroParamCount === 1) {
            resolvedReturnType =
              mapCSharpTypeToTypeSymbol(bestMeta.returnCsharpType) ?? null;
          }
        }
      }
    }

    // D3 method dispatch fallback: when the receiver is a Variable/Temporary
    // with an inline class type but no tracking entry, dispatch by runtime
    // handle. Mirrors the D3 property dispatch in expression.ts.
    if (
      (object.kind === TACOperandKind.Variable ||
        object.kind === TACOperandKind.Temporary) &&
      this.allInlineInstances.size > 0
    ) {
      const d3MethodResult = tryD3MethodDispatch(
        this,
        object,
        objectType,
        propAccess,
        rawArgs,
        evaluatedArgs,
      );
      if (d3MethodResult != null) return d3MethodResult;
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
    this.emitCopyWithTracking(objTemp, object);

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

  const isDictionaryType =
    (operandType === ExternTypes.dataDictionary ||
      operandType.name === ExternTypes.dataDictionary.name ||
      operandType.udonType === UdonType.DataDictionary ||
      resolvedIterableType === ExternTypes.dataDictionary ||
      resolvedIterableType?.name === ExternTypes.dataDictionary.name ||
      resolvedIterableType?.udonType === UdonType.DataDictionary) &&
    !isMapCollectionType(operandType) &&
    !isMapCollectionType(resolvedIterableType);

  const isArrayOrDataList =
    operandType instanceof ArrayTypeSymbol ||
    operandType.udonType === UdonType.Array ||
    operandType instanceof DataListTypeSymbol ||
    operandType.name === ExternTypes.dataList.name ||
    operandType.udonType === UdonType.DataList ||
    resolvedIterableType instanceof ArrayTypeSymbol ||
    resolvedIterableType?.udonType === UdonType.Array ||
    resolvedIterableType instanceof DataListTypeSymbol ||
    resolvedIterableType?.name === ExternTypes.dataList.name ||
    resolvedIterableType?.udonType === UdonType.DataList;

  if (elementType === ObjectType) {
    if (resolvedIterableType instanceof ArrayTypeSymbol) {
      elementType = resolvedIterableType.elementType;
    } else if (resolvedIterableType instanceof DataListTypeSymbol) {
      elementType = resolvedIterableType.elementType;
    }
  }

  if (isDictionaryType) {
    listOperand = emitSetKeysList(converter, iterableOperand, elementType);
  } else if (isArrayOrDataList) {
    // All arrays/DataList backed by DataList — keep listOperand as-is.
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
  // Current lowering policy: TS arrays use DataList semantics, so use Count.
  converter.instructions.push(
    new PropertyGetInstruction(lengthVar, listOperand, "Count"),
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

  // All iterables use DataList.get_Item → DataToken.
  const keyToken = converter.newTemp(ExternTypes.dataToken);
  converter.instructions.push(
    new MethodCallInstruction(keyToken, listOperand, "get_Item", [indexVar]),
  );

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
  let listOperand = iterableOperand;

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

  const isArrayOrDataList =
    operandType instanceof ArrayTypeSymbol ||
    operandType.udonType === UdonType.Array ||
    operandType instanceof DataListTypeSymbol ||
    operandType.name === ExternTypes.dataList.name ||
    operandType.udonType === UdonType.DataList ||
    resolvedIterableType instanceof ArrayTypeSymbol ||
    resolvedIterableType?.udonType === UdonType.Array ||
    resolvedIterableType instanceof DataListTypeSymbol ||
    resolvedIterableType?.name === ExternTypes.dataList.name ||
    resolvedIterableType?.udonType === UdonType.DataList;

  if (isDictionaryType) {
    listOperand = emitMapKeysList(converter, iterableOperand, keyType);
  } else if (isArrayOrDataList) {
    // All arrays/DataList backed by DataList — keep listOperand as-is.
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
  // Current lowering policy: TS arrays use DataList semantics, so use Count.
  converter.instructions.push(
    new PropertyGetInstruction(lengthVar, listOperand, "Count"),
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
  } else {
    // Both DataList and ArrayTypeSymbol are backed by DataList at runtime.
    // Elements are [key, value] pairs stored as nested DataLists.
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
          converter.emitCopyWithTracking(thisArgTemp, thisArg);
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
        converter.emitCopyWithTracking(paramVars[0], value);
      }
      if (paramVars[1]) {
        converter.emitCopyWithTracking(paramVars[1], value);
      }
      if (paramVars[2]) {
        converter.emitCopyWithTracking(paramVars[2], setOperand);
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
  mapType: TypeSymbol,
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
          converter.emitCopyWithTracking(thisArgTemp, thisArg);
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
        converter.emitCopyWithTracking(paramVars[0], valueValue);
      }
      if (paramVars[1]) {
        converter.emitCopyWithTracking(paramVars[1], keyValue);
      }
      if (paramVars[2]) {
        converter.emitCopyWithTracking(paramVars[2], mapOperand);
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

        // Current lowering policy: TS arrays use DataList semantics, so Count.
        this.instructions.push(
          new PropertyGetInstruction(lengthVar, source, "Count"),
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

        // All sources use DataList.get_Item → DataToken → Add.
        const itemToken = this.newTemp(ExternTypes.dataToken);
        this.instructions.push(
          new MethodCallInstruction(itemToken, source, "get_Item", [indexVar]),
        );
        this.instructions.push(
          new MethodCallInstruction(undefined, listResult, "Add", [itemToken]),
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
  paramTypes?: string[],
): string | null {
  const direct = resolveExternSignature(
    typeName,
    memberName,
    accessType,
    paramTypes,
  );
  if (direct) return direct;
  if (accessType === "getter") {
    return resolveExternSignature(typeName, memberName, "method", paramTypes);
  }
  return null;
}
