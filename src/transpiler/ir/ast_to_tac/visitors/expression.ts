import { typeMetadataRegistry } from "../../../codegen/type_metadata_registry.js";
import { TranspileError } from "../../../errors/transpile_errors.js";
import type { TypeMapper } from "../../../frontend/type_mapper.js";
import {
  ArrayTypeSymbol,
  ClassTypeSymbol,
  CollectionTypeSymbol,
  DataListTypeSymbol,
  ExternTypes,
  extractArrayLiteralHint,
  getNativeArrayTypeName,
  getPromotedType,
  InterfaceTypeSymbol,
  isPlainObjectType,
  mapCSharpTypeToTypeSymbol,
  NativeArrayTypeSymbol,
  ObjectType,
  PrimitiveTypeSymbol,
  PrimitiveTypes,
  type TypeSymbol,
  typeSymbolToCSharp,
} from "../../../frontend/type_symbols.js";
import type { SymbolInfo } from "../../../frontend/types.js";
import {
  type ArrayAccessExpressionNode,
  type ArrayLiteralExpressionNode,
  type ASTNode,
  ASTNodeKind,
  type AsExpressionNode,
  type AssignmentExpressionNode,
  type BinaryExpressionNode,
  type BlockStatementNode,
  type CallExpressionNode,
  type ConditionalExpressionNode,
  type DeleteExpressionNode,
  type IdentifierNode,
  type LiteralNode,
  type NameofExpressionNode,
  type NullCoalescingExpressionNode,
  needsInt32IndexCoercion,
  type ObjectLiteralExpressionNode,
  type OptionalChainingExpressionNode,
  type PropertyAccessExpressionNode,
  type ReturnStatementNode,
  type SuperExpressionNode,
  type TemplateExpressionNode,
  type ThisExpressionNode,
  type TypeofExpressionNode,
  UdonType,
  type UnaryExpressionNode,
  type UpdateExpressionNode,
} from "../../../frontend/types.js";
import {
  evaluateCastValue,
  isPrimitiveFoldValue,
} from "../../optimizer/passes/constant_folding.js";
import {
  ArrayAccessInstruction,
  ArrayAssignmentInstruction,
  AssignmentInstruction,
  BinaryOpInstruction,
  CallInstruction,
  CastInstruction,
  ConditionalJumpInstruction,
  CopyInstruction,
  LabelInstruction,
  MethodCallInstruction,
  PropertyGetInstruction,
  PropertySetInstruction,
  UnaryOpInstruction,
  UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import {
  type ConstantOperand,
  createConstant,
  createVariable,
  type TACOperand,
  TACOperandKind,
  type TemporaryOperand,
  type VariableOperand,
} from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";
import { emitArrayConcat } from "../helpers/assignment.js";
import {
  isMapCollectionType,
  isSetCollectionType,
} from "../helpers/collections.js";
import { resolveExternReturnType } from "../helpers/extern.js";
import {
  createSoaSentinelValue,
  emitStructuralFieldCopies,
  evaluateInlineGetter,
  hasAssignableStructuralProperty,
  hasCompatibleUnionProperty,
  initSoaForStructuralInterface,
  isInlineHandleType,
  isSubclassOf,
  isTrackedInlineHandleType,
  markUntrackedStructuralHandlePrefixes,
  operandTrackingKey,
  resolveClassMethod,
  resolveClassNode,
  resolveClassProperty,
  resolveConcreteClassName,
  resolveInlineClassType,
  usesInlineNullSentinel,
} from "../helpers/inline.js";
import { normalizeOperandToInt32 } from "../helpers/int32_normalization.js";
import {
  emitBoundedDataListGetItem,
  emitSoaHandleToIndex,
  SOA_PARTITION_SIZE,
} from "../helpers/soa_data_list.js";
import { emitSoaHandleRestore } from "../helpers/soa_handle_restore.js";
import { isAllInlineInterface } from "../helpers/udon_behaviour.js";

function ensureDataListForCount(
  converter: ASTToTACConverter,
  operand: TACOperand,
): TACOperand {
  const safeList = converter.newTemp(ExternTypes.dataList);
  const listCtorSig = converter.requireExternSignature(
    "DataList",
    "ctor",
    "method",
    [],
    "DataList",
  );
  converter.emit(new CallInstruction(safeList, listCtorSig, []));

  const boxedList = converter.newTemp(ObjectType);
  converter.emit(new CopyInstruction(boxedList, operand));
  const listIsNotNull = converter.newTemp(PrimitiveTypes.boolean);
  const listReady = converter.newLabel("datalist_ready");
  converter.emit(
    new BinaryOpInstruction(
      listIsNotNull,
      boxedList,
      "!=",
      createConstant(null, ObjectType),
    ),
  );
  converter.emit(new ConditionalJumpInstruction(listIsNotNull, listReady));
  converter.emit(new CopyInstruction(safeList, operand));
  converter.emit(new LabelInstruction(listReady));
  return safeList;
}

function markUntrackedInlineInterfaceArrayElement(
  converter: ASTToTACConverter,
  operand: TACOperand,
  elementType: TypeSymbol,
): void {
  const key = operandTrackingKey(operand);
  if (!key) return;
  const resolvedElementType = elementType.name
    ? (converter.typeMapper.getAlias(elementType.name) ?? elementType)
    : elementType;
  const interfaceName = resolvedElementType.name || elementType.name;
  if (
    interfaceName &&
    converter.classRegistry?.getInterface(interfaceName) &&
    isAllInlineInterface(converter, interfaceName)
  ) {
    markUntrackedStructuralHandlePrefixes(converter, key, resolvedElementType);
    const classIds = converter.interfaceClassIdMap.get(interfaceName);
    if (!classIds) return;
    const implementors = converter.classRegistry.getImplementorsOfInterface(
      interfaceName,
    );
    const implementorNames = new Set(implementors.map((impl) => impl.name));
    const classIdVar = createVariable(
      `${key}__classId`,
      PrimitiveTypes.int32,
      { isLocal: true },
    );
    converter.emit(
      new AssignmentInstruction(
        classIdVar,
        createConstant(-1, PrimitiveTypes.int32),
      ),
    );
    const handle = normalizeOperandToInt32(converter, operand);
    const endLabel = converter.newLabel("inline_iface_classid_end");
    for (const [instanceId, info] of converter.allInlineInstances) {
      if (!implementorNames.has(info.className)) continue;
      const classId = classIds.get(info.className);
      if (classId === undefined) continue;
      const nextLabel = converter.newLabel("inline_iface_classid_next");
      const cond = converter.newTemp(PrimitiveTypes.boolean);
      converter.emit(
        new BinaryOpInstruction(
          cond,
          handle,
          "==",
          createConstant(instanceId, PrimitiveTypes.int32),
        ),
      );
      converter.emit(new ConditionalJumpInstruction(cond, nextLabel));
      converter.emit(
        new AssignmentInstruction(
          classIdVar,
          createConstant(classId, PrimitiveTypes.int32),
        ),
      );
      converter.emit(new UnconditionalJumpInstruction(endLabel));
      converter.emit(new LabelInstruction(nextLabel));
    }
    converter.emit(new LabelInstruction(endLabel));
    converter.untrackedStructuralHandleClassIds.set(key, classIdVar);
  }
}

/**
 * Emit a DataList-indexed read for an SoA field, or return undefined if the
 * field is not in the per-field DataList (e.g. during construction, or for
 * computed fields that were not collected into a DataList).
 */
function tryReadSoAField(
  converter: ASTToTACConverter,
  instancePrefix: string,
  className: string,
  property: string,
): TACOperand | undefined {
  if (!instancePrefix) {
    return undefined;
  }
  if (instancePrefix.includes("__soa_mdisp_")) {
    return undefined;
  }
  if (
    converter.soaConstructionPrefixes.has(instancePrefix) ||
    !converter.soaInstancePrefixes.has(instancePrefix) ||
    !converter.soaClasses.has(className) ||
    !converter.soaFieldLists.has(className)
  )
    return undefined;
  const fieldLists = converter.soaFieldLists.get(className);
  if (!fieldLists) return undefined;
  const fieldList = fieldLists.get(property);
  if (!fieldList) return undefined;
  const hdlVar = createVariable(
    `${instancePrefix}__handle`,
    PrimitiveTypes.int32,
  );
  const indexVar = emitSoaHandleToIndex(converter, hdlVar, className);
  const token = converter.newTemp(ExternTypes.dataToken);
  const resolved = resolveClassProperty(converter, className, property);
  const fieldType =
    resolved?.prop.type ??
    converter.soaFieldTypes.get(className)?.get(property) ??
    ObjectType;
  emitBoundedDataListGetItem(
    converter,
    fieldList,
    indexVar,
    token,
    () => createSoaSentinelValue(converter, fieldType),
    true,
    className,
  );
  const unwrapped = converter.unwrapDataToken(token, fieldType);
  const unwrappedKey = operandTrackingKey(unwrapped);
  if (unwrappedKey) {
    const nestedPrefix = `${property}_`;
    const fieldTypes = converter.soaFieldTypes.get(className);
    for (const [nestedField, nestedList] of fieldLists) {
      if (!nestedField.startsWith(nestedPrefix)) continue;
      const nestedName = nestedField.slice(nestedPrefix.length);
      if (nestedName.length === 0) continue;
      const nestedType = fieldTypes?.get(nestedField) ?? ObjectType;
      const nestedToken = converter.newTemp(ExternTypes.dataToken);
      emitBoundedDataListGetItem(
        converter,
        nestedList,
        indexVar,
        nestedToken,
        () => createSoaSentinelValue(converter, nestedType),
        true,
        className,
      );
      const nestedValue = converter.unwrapDataToken(nestedToken, nestedType);
      const nestedSlot = createVariable(
        `${unwrappedKey}_${nestedName}`,
        nestedType,
      );
      converter.emit(new CopyInstruction(nestedSlot, nestedValue));
      converter.structuralFieldPrefixes.add(unwrappedKey);
      const prefixTypes =
        converter.structuralFieldPrefixTypes.get(unwrappedKey) ??
        new Map<string, TypeSymbol>();
      prefixTypes.set(nestedName, nestedType);
      converter.structuralFieldPrefixTypes.set(unwrappedKey, prefixTypes);
    }
  }
  return unwrapped;
}

function tryMapAliasInlineProperty(
  converter: ASTToTACConverter,
  className: string,
  instancePrefix: string,
  property: string,
): TACOperand | undefined {
  const alias = converter.typeMapper.getAlias(className);
  if (!(alias instanceof InterfaceTypeSymbol)) return undefined;
  const propertyType = alias.properties.get(property);
  if (!propertyType) return undefined;
  return createVariable(`${instancePrefix}_${property}`, propertyType);
}

function tryMapAnonymousUnionInlineProperty(
  converter: ASTToTACConverter,
  className: string,
  instancePrefix: string,
  property: string,
  fallbackUnion: InterfaceTypeSymbol | null,
  fallbackType?: TypeSymbol,
): TACOperand | undefined {
  if (!className.startsWith("__anon_union_")) return undefined;
  const alias = converter.typeMapper.getAlias(className);
  const propertyType =
    alias instanceof InterfaceTypeSymbol
      ? (alias.properties.get(property) ??
        fallbackUnion?.properties.get(property) ??
        fallbackType)
      : (fallbackUnion?.properties.get(property) ?? fallbackType);
  if (!propertyType) return undefined;
  const resolvedType = propertyType.name
    ? (converter.typeMapper.getAlias(propertyType.name) ?? propertyType)
    : propertyType;
  return createVariable(`${instancePrefix}_${property}`, resolvedType);
}

function emitSoaNestedStructuralFieldCopies(
  converter: ASTToTACConverter,
  targetPrefix: string,
  ownerClassName: string,
  ownerProperty: string,
  indexVar: TACOperand,
): boolean {
  const fieldLists = converter.soaFieldLists.get(ownerClassName);
  if (!fieldLists) return false;
  const fieldTypes = converter.soaFieldTypes.get(ownerClassName);
  const nestedPrefix = `${ownerProperty}_`;
  let copied = false;
  for (const [nestedField, nestedList] of fieldLists) {
    if (!nestedField.startsWith(nestedPrefix)) continue;
    const nestedName = nestedField.slice(nestedPrefix.length);
    if (nestedName.length === 0) continue;
    const nestedType = fieldTypes?.get(nestedField) ?? ObjectType;
    const nestedToken = converter.newTemp(ExternTypes.dataToken);
    emitBoundedDataListGetItem(
      converter,
      nestedList,
      indexVar,
      nestedToken,
      () => createSoaSentinelValue(converter, nestedType),
      true,
      ownerClassName,
    );
    const nestedValue = converter.unwrapDataToken(nestedToken, nestedType);
    const nestedSlot = createVariable(
      `${targetPrefix}_${nestedName}`,
      nestedType,
      { isLocal: true },
    );
    converter.emit(new CopyInstruction(nestedSlot, nestedValue));
    converter.structuralFieldPrefixes.add(targetPrefix);
    const prefixTypes =
      converter.structuralFieldPrefixTypes.get(targetPrefix) ??
      new Map<string, TypeSymbol>();
    prefixTypes.set(nestedName, nestedType);
    converter.structuralFieldPrefixTypes.set(targetPrefix, prefixTypes);
    copied = true;
  }
  return copied;
}

function inferInlineStructuralPropertyType(
  converter: ASTToTACConverter,
  property: string,
): TypeSymbol | undefined {
  if (converter.inlineStructuralPropertyTypeCache.has(property)) {
    return converter.inlineStructuralPropertyTypeCache.get(property);
  }

  let inferred: TypeSymbol | undefined;
  const checkedClasses = new Set<string>();
  for (const [, info] of converter.allInlineInstances) {
    if (checkedClasses.has(info.className)) continue;
    checkedClasses.add(info.className);

    const propertyPrefixInfo = converter.resolveInlineInstance(
      `${info.prefix}_${property}`,
    );
    if (propertyPrefixInfo) {
      const alias = converter.typeMapper.getAlias(propertyPrefixInfo.className);
      if (!(alias instanceof InterfaceTypeSymbol)) continue;
      const concreteType = alias;
      if (!inferred) {
        inferred = concreteType;
        continue;
      }
      if (
        inferred.name !== concreteType.name ||
        inferred.udonType !== concreteType.udonType
      ) {
        return undefined;
      }
      continue;
    }

    const resolved = resolveClassProperty(converter, info.className, property);
    const alias = converter.typeMapper.getAlias(info.className);
    const propertyType =
      resolved?.prop.getterReturnType ??
      resolved?.prop.type ??
      (alias instanceof InterfaceTypeSymbol
        ? alias.properties.get(property)
        : undefined);
    if (!propertyType) continue;

    const concreteType = propertyType.name
      ? (converter.typeMapper.getAlias(propertyType.name) ?? propertyType)
      : propertyType;
    if (concreteType === ObjectType) {
      continue;
    }
    if (!inferred) {
      inferred = concreteType;
      continue;
    }
    if (
      inferred.name !== concreteType.name ||
      inferred.udonType !== concreteType.udonType
    ) {
      return undefined;
    }
  }
  if (inferred) {
    converter.inlineStructuralPropertyTypeCache.set(property, inferred);
  }
  return inferred;
}

function resolveNestedStructuralPropertyType(
  converter: ASTToTACConverter,
  receiverType: TypeSymbol | undefined,
  baseProperty: string,
  nestedProperty: string,
): TypeSymbol | undefined {
  const receiverInterface =
    receiverType instanceof InterfaceTypeSymbol
      ? receiverType
      : receiverType?.name
        ? converter.typeMapper.getAlias(receiverType.name)
        : undefined;
  if (!(receiverInterface instanceof InterfaceTypeSymbol)) return undefined;
  const baseType = receiverInterface.properties.get(baseProperty);
  if (!baseType) return undefined;
  const resolvedBase = baseType.name
    ? (converter.typeMapper.getAlias(baseType.name) ?? baseType)
    : baseType;
  if (!(resolvedBase instanceof InterfaceTypeSymbol)) return undefined;
  const nestedType = resolvedBase.properties.get(nestedProperty);
  return nestedType?.name
    ? (converter.typeMapper.getAlias(nestedType.name) ?? nestedType)
    : nestedType;
}

function resolveStructuralInterface(
  converter: ASTToTACConverter,
  type: TypeSymbol | undefined,
): InterfaceTypeSymbol | undefined {
  if (type instanceof InterfaceTypeSymbol) return type;
  const alias = type?.name
    ? converter.typeMapper.getAlias(type.name)
    : undefined;
  return alias instanceof InterfaceTypeSymbol ? alias : undefined;
}

function resolveStructuralPropertyType(
  converter: ASTToTACConverter,
  receiverType: TypeSymbol | undefined,
  property: string,
): TypeSymbol | undefined {
  const iface = resolveStructuralInterface(converter, receiverType);
  if (!iface || !iface.properties.has(property)) {
    const registryType =
      converter.fieldTypeRegistry.getStructuralFieldType(property);
    return registryType
      ? (inferInlineStructuralPropertyType(converter, property) ?? registryType)
      : undefined;
  }
  const registryType = converter.fieldTypeRegistry.getInterfacePropertyType(
    {
      typeMapper: converter.typeMapper,
      classRegistry: converter.classRegistry,
    },
    iface.name,
    property,
  );
  const rawType = iface.properties.get(property);
  return (
    registryType ??
    (rawType?.name
      ? (converter.typeMapper.getAlias(rawType.name) ?? rawType)
    : rawType)
  );
}

function emitKnownStructuralFieldCopies(
  converter: ASTToTACConverter,
  sourcePrefix: string,
  targetPrefix: string,
  seen: Set<string> = new Set(),
  depth = 0,
): boolean {
  if (depth >= 8) return false;
  const sourceFieldTypes =
    converter.structuralFieldPrefixTypes.get(sourcePrefix);
  if (!sourceFieldTypes || sourceFieldTypes.size === 0) return false;
  const seenKey = `${sourcePrefix}:${targetPrefix}`;
  if (seen.has(seenKey)) return false;
  seen.add(seenKey);

  converter.structuralFieldPrefixes.add(targetPrefix);
  const targetFieldTypes =
    converter.structuralFieldPrefixTypes.get(targetPrefix) ??
    new Map<string, TypeSymbol>();
  converter.structuralFieldPrefixTypes.set(targetPrefix, targetFieldTypes);

  for (const [propertyName, propertyType] of sourceFieldTypes) {
    targetFieldTypes.set(propertyName, propertyType);
    converter.emit(
      new CopyInstruction(
        createVariable(`${targetPrefix}_${propertyName}`, propertyType, {
          isLocal: true,
        }),
        createVariable(`${sourcePrefix}_${propertyName}`, propertyType),
      ),
    );
    emitKnownStructuralFieldCopies(
      converter,
      `${sourcePrefix}_${propertyName}`,
      `${targetPrefix}_${propertyName}`,
      seen,
      depth + 1,
    );
  }
  return true;
}

function clearUntrackedStructuralPrefixes(
  converter: ASTToTACConverter,
  prefix: string,
  structuralType: InterfaceTypeSymbol,
  seen: Set<string> = new Set(),
): void {
  const seenKey = `${prefix}:${structuralType.name}`;
  if (seen.has(seenKey)) return;
  seen.add(seenKey);
  converter.untrackedStructuralHandleVars.delete(prefix);
  converter.untrackedStructuralHandleTypes.delete(prefix);
  converter.untrackedStructuralHandleClassIds.delete(prefix);
  for (const [propertyName, rawPropertyType] of structuralType.properties) {
    const propertyType = resolveStructuralPropertyType(
      converter,
      structuralType,
      propertyName,
    ) ?? rawPropertyType;
    const nestedType = resolveStructuralInterface(converter, propertyType);
    if (nestedType) {
      clearUntrackedStructuralPrefixes(
        converter,
        `${prefix}_${propertyName}`,
        nestedType,
        seen,
      );
    }
  }
}

function structuralInterfacesCompatible(
  target: InterfaceTypeSymbol,
  source: InterfaceTypeSymbol | undefined,
): boolean {
  if (!source || source.methods.size > 0) return false;
  for (const propertyName of target.properties.keys()) {
    if (!source.properties.has(propertyName)) return false;
  }
  return true;
}

function emitStructuralFieldsFromKnownHandle(
  converter: ASTToTACConverter,
  targetPrefix: string,
  targetType: TypeSymbol,
  sourceHandle: TACOperand,
  targetOptions: { isParameter?: boolean; isLocal?: boolean } = {},
): boolean {
  const targetInterface = resolveStructuralInterface(converter, targetType);
  const sourceKey = operandTrackingKey(sourceHandle);
  if (!targetInterface || !sourceKey) return false;

  const candidates = Array.from(converter.allInlineInstances.entries()).filter(
    ([, info]) => {
      const sourceInterface = resolveStructuralInterface(
        converter,
        new ClassTypeSymbol(info.className, UdonType.Object),
      );
      if (structuralInterfacesCompatible(targetInterface, sourceInterface)) {
        return true;
      }
      return Array.from(targetInterface.properties.keys()).every(
        (propertyName) =>
          resolveClassProperty(converter, info.className, propertyName) !==
          undefined,
      );
    },
  );
  if (candidates.length === 0) return false;

  converter.structuralFieldPrefixes.add(targetPrefix);
  const targetFieldTypes =
    converter.structuralFieldPrefixTypes.get(targetPrefix) ??
    new Map<string, TypeSymbol>();
  converter.structuralFieldPrefixTypes.set(targetPrefix, targetFieldTypes);
  clearUntrackedStructuralPrefixes(converter, targetPrefix, targetInterface);

  const hdlVar = normalizeOperandToInt32(converter, sourceHandle);
  const dispatchEnd = converter.newLabel("struct_field_sync_end");
  for (const [, info] of candidates) {
    const dispatchNext = converter.newLabel("struct_field_sync_next");
    const dispatchCond = converter.newTemp(PrimitiveTypes.boolean);
    converter.emit(
      new BinaryOpInstruction(
        dispatchCond,
        hdlVar,
        "==",
        createVariable(`${info.prefix}__handle`, PrimitiveTypes.int32),
      ),
    );
    converter.emit(new ConditionalJumpInstruction(dispatchCond, dispatchNext));

    for (const [propertyName, rawPropertyType] of targetInterface.properties) {
      const propertyType =
        resolveStructuralPropertyType(converter, targetInterface, propertyName) ??
        rawPropertyType;
      targetFieldTypes.set(propertyName, propertyType);
      const sourceProperty = converter.mapInlineProperty(
        info.className,
        info.prefix,
        propertyName,
      );
      if (!sourceProperty) continue;
      const targetProperty = createVariable(
        `${targetPrefix}_${propertyName}`,
        propertyType,
        targetOptions,
      );
      converter.emitCopyWithTracking(targetProperty, sourceProperty);
      const sourcePropertyKey = operandTrackingKey(sourceProperty);
      const targetPropertyKey = operandTrackingKey(targetProperty);
      if (sourcePropertyKey && targetPropertyKey) {
        emitKnownStructuralFieldCopies(
          converter,
          sourcePropertyKey,
          targetPropertyKey,
        );
      }
    }
    converter.emit(new UnconditionalJumpInstruction(dispatchEnd));
    converter.emit(new LabelInstruction(dispatchNext));
  }
  converter.emit(new LabelInstruction(dispatchEnd));
  return true;
}

function identifierSlotName(
  converter: ASTToTACConverter,
  name: string,
  symbol?: SymbolInfo,
): string {
  return (
    converter.currentParamExportMap.get(name) ?? symbol?.heapSlotName ?? name
  );
}

function tryReadPopulatedStructuralFieldSlot(
  converter: ASTToTACConverter,
  slotBase: string,
  receiverType: TypeSymbol | undefined,
  property: string,
): TACOperand | undefined {
  if (converter.untrackedStructuralHandleVars.has(slotBase)) return undefined;
  const receiverInterface = resolveStructuralInterface(converter, receiverType);
  if (receiverInterface?.methods.size) return undefined;
  if (!converter.structuralFieldPrefixes.has(slotBase)) return undefined;
  const propType =
    resolveStructuralPropertyType(converter, receiverType, property) ??
    converter.structuralFieldPrefixTypes.get(slotBase)?.get(property);
  if (!propType) return undefined;
  return createVariable(`${slotBase}_${property}`, propType, { isLocal: true });
}

function tryEmitStructuralInterfacePropertyDispatch(
  converter: ASTToTACConverter,
  object: TACOperand,
  interfaceType: InterfaceTypeSymbol,
  property: string,
  resultType: TypeSymbol,
): TACOperand | undefined {
  const dispInstances: Array<[number, { prefix: string; className: string }]> =
    [];
  for (const [instId, info] of converter.allInlineInstances) {
    if (
      hasAssignableStructuralProperty(
        converter,
        info.className,
        interfaceType,
        property,
      )
    ) {
      dispInstances.push([instId, info]);
    }
  }
  const dispatchLimit = converter.dispatchLimitResolver.getLimit({
    property,
    usedErasedFallback: true,
    isStructuralUnionDispatch: true,
  });
  if (dispInstances.length === 0 || dispInstances.length > dispatchLimit) {
    return undefined;
  }

  const result = converter.newTemp(resultType);
  converter.emit(
    new AssignmentInstruction(
      result,
      createSoaSentinelValue(converter, resultType),
    ),
  );
  const hdlVar = normalizeOperandToInt32(converter, object);
  const endLabel = converter.newLabel("struct_prop_end");
  for (const [, info] of dispInstances) {
    const nextLabel = converter.newLabel("struct_prop_next");
    const cond = converter.newTemp(PrimitiveTypes.boolean);
    const isRuntimeSoAInstance = converter.soaInstancePrefixes.has(info.prefix);
    if (isRuntimeSoAInstance && converter.soaClasses.has(info.className)) {
      const offset = converter.soaClassOffsets.get(info.className);
      if (offset === undefined) {
        converter.emit(
          new BinaryOpInstruction(
            cond,
            hdlVar,
            "==",
            createVariable(`${info.prefix}__handle`, PrimitiveTypes.int32),
          ),
        );
      } else {
        const lowerCond = converter.newTemp(PrimitiveTypes.boolean);
        const upperCond = converter.newTemp(PrimitiveTypes.boolean);
        const rangeEnd = converter.newLabel("struct_prop_range_end");
        converter.emit(
          new AssignmentInstruction(
            cond,
            createConstant(false, PrimitiveTypes.boolean),
          ),
        );
        converter.emit(
          new BinaryOpInstruction(
            lowerCond,
            hdlVar,
            ">=",
            createConstant(offset + 1, PrimitiveTypes.int32),
          ),
        );
        converter.emit(new ConditionalJumpInstruction(lowerCond, rangeEnd));
        converter.emit(
          new BinaryOpInstruction(
            upperCond,
            hdlVar,
            "<",
            createConstant(offset + SOA_PARTITION_SIZE, PrimitiveTypes.int32),
          ),
        );
        converter.emit(new ConditionalJumpInstruction(upperCond, rangeEnd));
        converter.emit(
          new AssignmentInstruction(
            cond,
            createConstant(true, PrimitiveTypes.boolean),
          ),
        );
        converter.emit(new LabelInstruction(rangeEnd));
      }
    } else {
      const instanceHandle = createVariable(
        `${info.prefix}__handle`,
        PrimitiveTypes.int32,
      );
      const nonZeroHandleCond = converter.newTemp(PrimitiveTypes.boolean);
      converter.emit(
        new BinaryOpInstruction(cond, hdlVar, "==", instanceHandle),
      );
      converter.emit(
        new BinaryOpInstruction(
          nonZeroHandleCond,
          instanceHandle,
          "!=",
          createConstant(0, PrimitiveTypes.int32),
        ),
      );
      converter.emit(new ConditionalJumpInstruction(cond, nextLabel));
      converter.emit(
        new ConditionalJumpInstruction(nonZeroHandleCond, nextLabel),
      );
    }
    if (isRuntimeSoAInstance && converter.soaClasses.has(info.className)) {
      const fieldList = converter.soaFieldLists
        .get(info.className)
        ?.get(property);
      if (fieldList) {
        const indexVar = emitSoaHandleToIndex(
          converter,
          hdlVar,
          info.className,
        );
        const token = converter.newTemp(ExternTypes.dataToken);
        emitBoundedDataListGetItem(
          converter,
          fieldList,
          indexVar,
          token,
          createSoaSentinelValue(converter, resultType),
          true,
          info.className,
        );
        converter.emitCopyWithTracking(
          result,
          converter.unwrapDataToken(token, resultType),
        );
      }
    } else {
      const mapped =
        converter.mapInlineProperty(info.className, info.prefix, property) ??
        tryMapAliasInlineProperty(
          converter,
          info.className,
          info.prefix,
          property,
        );
      if (mapped) {
        converter.emitCopyWithTracking(result, mapped);
      }
    }
    converter.emit(new UnconditionalJumpInstruction(endLabel));
    converter.emit(new LabelInstruction(nextLabel));
  }
  converter.emit(new LabelInstruction(endLabel));
  return result;
}

function inferIdentifierInitialPropertyClassName(
  converter: ASTToTACConverter,
  node: ASTNode,
): string | undefined {
  if (node.kind !== ASTNodeKind.Identifier) return undefined;
  const name = (node as IdentifierNode).name;
  const symbol = converter.symbolTable.lookup(name);
  const initialValue = symbol?.initialValue as ASTNode | undefined;
  if (initialValue?.kind !== ASTNodeKind.PropertyAccessExpression) {
    return undefined;
  }
  const access = initialValue as PropertyAccessExpressionNode;
  const receiverType = resolveTypeFromNode(converter, access.object);
  if (!receiverType?.name) return undefined;
  const propType = converter.fieldTypeRegistry.getInterfacePropertyType(
    {
      typeMapper: converter.typeMapper,
      classRegistry: converter.classRegistry,
    },
    receiverType.name,
    access.property,
  );
  return propType?.name;
}

/**
 * Try to map an inline property, falling back to concrete class resolution
 * when the className is an interface/type alias.
 *
 * When the resolved property is a class getter, inline the getter body via
 * evaluateInlineGetter (which reuses the method-inlining core). Plain
 * fields continue to return a VariableOperand pointing at the SoA-backed
 * slot.
 */
function tryMapInlinePropertyWithConcreteFallback(
  converter: ASTToTACConverter,
  instanceInfo: { prefix: string; className: string },
  property: string,
): TACOperand | undefined {
  // Try getter first (getters have no DataList entry; they must inline their body).
  const primaryGetter = tryInlineGetter(
    converter,
    instanceInfo.className,
    instanceInfo.prefix,
    property,
  );
  if (primaryGetter !== undefined) return primaryGetter;

  const soaClassName = resolveConcreteClassName(converter, instanceInfo);
  const soaResult = tryReadSoAField(
    converter,
    instanceInfo.prefix,
    soaClassName,
    property,
  );
  if (soaResult !== undefined) return soaResult;

  const mapped = converter.mapInlineProperty(
    instanceInfo.className,
    instanceInfo.prefix,
    property,
  );
  if (mapped) return mapped;

  if (soaClassName !== instanceInfo.className) {
    const concreteGetter = tryInlineGetter(
      converter,
      soaClassName,
      instanceInfo.prefix,
      property,
    );
    if (concreteGetter !== undefined) return concreteGetter;
    return converter.mapInlineProperty(
      soaClassName,
      instanceInfo.prefix,
      property,
    );
  }
  return undefined;
}

/**
 * Resolve the property on `className` and, if it is a getter, inline its
 * body. Returns the inlined result operand when successful, or `undefined`
 * when the property is not a getter on this class OR when inlining was
 * declined (e.g. inline-stack recursion detected by
 * `evaluateInlineGetter`, which returns null that this wrapper collapses
 * to `undefined`). Callers cannot distinguish the two `undefined` cases.
 *
 * TypeScript accepts self-referential getters with explicit return type
 * annotations, so recursive getters can reach the transpiler. They are
 * detected at IR-generation time via `inlineMethodStack`; on detection
 * the read emits an `EntryPointGetterUnsupported` or
 * `D3DispatchFallback` diagnostic and the caller takes a safe fallback
 * (phantom-slot read or no-op dispatch arm).
 */
function tryInlineGetter(
  converter: ASTToTACConverter,
  className: string,
  instancePrefix: string,
  property: string,
): TACOperand | undefined {
  const resolved = resolveClassProperty(converter, className, property);
  if (!resolved?.prop.isGetter) return undefined;
  // Bind `this` to the receiver's class (`className`), not the getter's
  // declaring class. Matches inlineInstanceMethodCallCore semantics: a
  // base-class getter accessed on a derived instance sees the derived
  // class's SoA prefix for `this.*` resolution via mapInlineProperty's
  // derived-first walk. Using declaringClassName would wrongly hide
  // derived-only fields from the inlined body.
  const inlined = evaluateInlineGetter(
    converter,
    resolved.prop,
    className,
    instancePrefix,
  );
  return inlined ?? undefined;
}

function resolveSimpleGetterBackingField(getter: {
  getterBody?: ASTNode;
}): string | null {
  const body = getter.getterBody;
  if (body?.kind !== ASTNodeKind.BlockStatement) return null;
  const statements = (body as BlockStatementNode).statements;
  if (statements.length !== 1) return null;
  const stmt = statements[0];
  if (stmt?.kind !== ASTNodeKind.ReturnStatement) return null;
  const value = (stmt as ReturnStatementNode).value;
  if (value?.kind !== ASTNodeKind.PropertyAccessExpression) return null;
  const access = value as PropertyAccessExpressionNode;
  if (access.object.kind !== ASTNodeKind.ThisExpression) return null;
  return access.property;
}

const NUMERIC_UDON_TYPES = new Set([
  UdonType.Byte,
  UdonType.SByte,
  UdonType.Int16,
  UdonType.UInt16,
  UdonType.Int32,
  UdonType.UInt32,
  UdonType.Int64,
  UdonType.UInt64,
  UdonType.Single,
  UdonType.Double,
]);

const FLOAT_UDON_TYPES = new Set([UdonType.Single, UdonType.Double]);

/** Range bounds for integer types where evaluateCastValue does not clamp. */
const INTEGER_RANGE: Partial<Record<string, [number, number]>> = {
  Byte: [0, 255],
  SByte: [-128, 127],
  Int16: [-32768, 32767],
  UInt16: [0, 65535],
  Int32: [-2147483648, 2147483647],
  UInt32: [0, 4294967295],
};

function canFoldNumericLiteral(
  value: number | string | boolean | bigint,
  targetUdonType: string,
): boolean {
  if (typeof value !== "number") return true;
  if (!Number.isFinite(value)) return false;
  const range = INTEGER_RANGE[targetUdonType];
  if (!range) return true;
  const trunc = Math.trunc(value);
  return trunc >= range[0] && trunc <= range[1];
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;

/**
 * Re-type a numeric ConstantOperand to a contextual target type, truncating
 * fractional values when narrowing to an integer slot. Returns null when the
 * conversion is unsafe (non-numeric value, non-finite → integer, or out-of-
 * range integer) so the caller can fall through to rank-based widening.
 *
 * Int64/UInt64 targets use bigint to match `evaluateCastValue` in
 * `constant_folding.ts`: 64-bit integer constants must survive round-trip
 * through the optimizer's dedup/fold passes, which expect bigint values.
 * Out-of-range values (e.g. `-1` targeting UInt64, or `2**63` targeting
 * Int64) return null so the caller falls through to rank-based widening
 * rather than emitting a bigint that would fail assembler range checks.
 */
function retypeNumericConstant(
  c: ConstantOperand,
  target: PrimitiveTypeSymbol,
): ConstantOperand | null {
  const targetIsFloat = FLOAT_UDON_TYPES.has(target.udonType);
  const targetIs64 =
    target.udonType === UdonType.Int64 || target.udonType === UdonType.UInt64;
  if (targetIs64) {
    const isUnsigned = target.udonType === UdonType.UInt64;
    const [min, max] = isUnsigned ? [0n, UINT64_MAX] : [INT64_MIN, INT64_MAX];
    try {
      let bigValue: bigint;
      if (typeof c.value === "bigint") {
        bigValue = c.value;
      } else if (typeof c.value === "number") {
        if (!Number.isFinite(c.value)) return null;
        bigValue = BigInt(Math.trunc(c.value));
      } else {
        return null;
      }
      if (bigValue < min || bigValue > max) return null;
      return createConstant(bigValue, target) as ConstantOperand;
    } catch {
      return null;
    }
  }
  if (typeof c.value !== "number") return null;
  if (!targetIsFloat && !Number.isFinite(c.value)) return null;
  const newValue = targetIsFloat ? c.value : Math.trunc(c.value);
  if (!targetIsFloat) {
    const range = INTEGER_RANGE[target.udonType];
    if (range && (newValue < range[0] || newValue > range[1])) return null;
  }
  return createConstant(newValue, target) as ConstantOperand;
}

/**
 * Widen operands to a common promoted numeric type when they differ.
 * Returns the (possibly widened) operands.
 *
 * Contextual preference: when `currentExpectedType` is a numeric primitive and
 * exactly one operand already matches it, a numeric ConstantOperand on the
 * other side is re-typed to the expected type (possibly lossy for fractional→
 * integer). This keeps arithmetic in the contextual lane rather than widening
 * the already-matching side and emitting a Convert.ToSingle(Int32)-shaped
 * extern. The source must already have conceded precision via an enclosing
 * integer assignment for this to fire on a fractional literal.
 *
 * Divergence note: `intField = intVar + 0.5` now truncates the constant to `0`
 * BEFORE the add, so `intVar=-3` yields `-3` (not `-2` as the master widen-
 * then-narrow path produced). Matches "the user wrote a fractional literal in
 * an integer context" but is not arithmetically equivalent to the pre-change
 * path. Variable+variable arithmetic is untouched.
 *
 * Note on scope: `visitAsExpression` save/restores `currentExpectedType` for
 * its own inner subtree, so the right operand of an outer binary op sees the
 * outer (assignment) context, not any brand-strip target inside the left.
 */
function widenNumericOperands(
  converter: ASTToTACConverter,
  left: TACOperand,
  right: TACOperand,
): { left: TACOperand; right: TACOperand } {
  const leftSym = converter.getOperandType(left);
  const rightSym = converter.getOperandType(right);
  if (leftSym.udonType === rightSym.udonType) {
    return { left, right };
  }
  const expected = converter.currentExpectedType;
  if (
    expected instanceof PrimitiveTypeSymbol &&
    NUMERIC_UDON_TYPES.has(expected.udonType)
  ) {
    const leftIsConst = left.kind === TACOperandKind.Constant;
    const rightIsConst = right.kind === TACOperandKind.Constant;
    const leftMatches = leftSym.udonType === expected.udonType;
    const rightMatches = rightSym.udonType === expected.udonType;
    if (
      leftMatches &&
      rightIsConst &&
      NUMERIC_UDON_TYPES.has(rightSym.udonType)
    ) {
      const retyped = retypeNumericConstant(right as ConstantOperand, expected);
      if (retyped) return { left, right: retyped };
    }
    if (
      rightMatches &&
      leftIsConst &&
      NUMERIC_UDON_TYPES.has(leftSym.udonType)
    ) {
      const retyped = retypeNumericConstant(left as ConstantOperand, expected);
      if (retyped) return { left: retyped, right };
    }
  }
  // If one operand is a non-float integer variable and the other is a
  // floating-point constant whose value is a whole number, retype the
  // constant to the integer type.  This covers the `1 + intVar` pattern
  // when no `currentExpectedType` is available from the outer context.
  // Fractional constants (e.g. 1.5) are left unchanged so the caller
  // falls through to rank-based widening instead of truncating silently.
  {
    const leftIsConst = left.kind === TACOperandKind.Constant;
    const rightIsConst = right.kind === TACOperandKind.Constant;
    if (
      !leftIsConst &&
      rightIsConst &&
      NUMERIC_UDON_TYPES.has(leftSym.udonType) &&
      !FLOAT_UDON_TYPES.has(leftSym.udonType) &&
      FLOAT_UDON_TYPES.has(rightSym.udonType) &&
      leftSym instanceof PrimitiveTypeSymbol
    ) {
      const rv = (right as ConstantOperand).value;
      if (typeof rv === "number" && Number.isInteger(rv)) {
        const retyped = retypeNumericConstant(
          right as ConstantOperand,
          leftSym,
        );
        if (retyped) return { left, right: retyped };
      }
    }
    if (
      !rightIsConst &&
      leftIsConst &&
      NUMERIC_UDON_TYPES.has(rightSym.udonType) &&
      !FLOAT_UDON_TYPES.has(rightSym.udonType) &&
      FLOAT_UDON_TYPES.has(leftSym.udonType) &&
      rightSym instanceof PrimitiveTypeSymbol
    ) {
      const lv = (left as ConstantOperand).value;
      if (typeof lv === "number" && Number.isInteger(lv)) {
        const retyped = retypeNumericConstant(
          left as ConstantOperand,
          rightSym,
        );
        if (retyped) return { left: retyped, right };
      }
    }
  }
  const promoted = getPromotedType(leftSym, rightSym);
  if (!promoted) {
    return { left, right };
  }
  let newLeft = left;
  let newRight = right;
  if (leftSym.udonType !== promoted.udonType) {
    const w = converter.newTemp(promoted);
    converter.emit(new CastInstruction(w, left));
    newLeft = w;
  }
  if (rightSym.udonType !== promoted.udonType) {
    const w = converter.newTemp(promoted);
    converter.emit(new CastInstruction(w, right));
    newRight = w;
  }
  return { left: newLeft, right: newRight };
}

const BITWISE_FLOAT_TYPES: ReadonlySet<UdonType> = new Set([
  UdonType.Single,
  UdonType.Double,
]);

/**
 * Narrow floating-point operands to Int32 for bitwise operators (|, &, ^).
 * Udon VM has no bitwise ops on Single/Double; applying them generates
 * invalid EXTERNs like SystemSingle.__op_LogicalOr__. Other integer types
 * (Int16, UInt32, etc.) are left unchanged — they either have native
 * bitwise support or will fail at codegen with a clear extern-not-found error.
 */
function narrowToInt32ForBitwise(
  converter: ASTToTACConverter,
  left: TACOperand,
  right: TACOperand,
): { left: TACOperand; right: TACOperand } {
  const leftType = converter.getOperandType(left);
  const rightType = converter.getOperandType(right);
  let newLeft = left;
  let newRight = right;
  if (BITWISE_FLOAT_TYPES.has(leftType.udonType)) {
    const cast = converter.newTemp(PrimitiveTypes.int32);
    converter.emit(new CastInstruction(cast, left));
    newLeft = cast;
  }
  if (BITWISE_FLOAT_TYPES.has(rightType.udonType)) {
    const cast = converter.newTemp(PrimitiveTypes.int32);
    converter.emit(new CastInstruction(cast, right));
    newRight = cast;
  }
  return { left: newLeft, right: newRight };
}

/**
 * Narrow Int64/UInt64 remainder operands to a 32-bit type and emit a warning.
 * Called for both `%` and `%=` so both paths avoid unsupported 64-bit externs.
 * Returns the (possibly cast) operands; caller is responsible for the
 * subsequent widenNumericOperands call.
 */
function narrowLongForRemainder(
  converter: ASTToTACConverter,
  node: ASTNode | undefined,
  left: TACOperand,
  right: TACOperand,
): { left: TACOperand; right: TACOperand } {
  const leftType = converter.getOperandType(left);
  const rightType = converter.getOperandType(right);
  const leftIsLong =
    leftType.udonType === UdonType.Int64 ||
    leftType.udonType === UdonType.UInt64;
  const rightIsLong =
    rightType.udonType === UdonType.Int64 ||
    rightType.udonType === UdonType.UInt64;
  if (!(leftIsLong || rightIsLong)) return { left, right };

  converter.warnAt(
    node,
    "Int64RemainderNotSupported",
    "Udon VM does not support Int64/UInt64 remainder (%). Narrowing operand(s) to 32-bit.",
  );

  // narrowTarget avoids a same-rank-3 mixed-sign (int32+uint32) pair, which
  // is the only case where widenNumericOperands re-promotes to Int64:
  //   • Both Long: uint32 when both are UInt64, int32 otherwise (mixed
  //     Int64/UInt64 uses int32, mirroring C#'s int+uint→long precedent).
  //   • One Long: uint32 when the non-Long side is UInt32 (avoids the
  //     int32+uint32 pair); int32 in all other cases.
  // Note: UInt64 values in [2^31, 2^32) are sign-extended when narrowed to
  // int32 (e.g. UInt64 % Int32). This is a best-effort degradation — Udon VM
  // offers no 64-bit remainder at all, so some precision loss is unavoidable.
  let narrowTarget: TypeSymbol;
  if (leftIsLong && rightIsLong) {
    narrowTarget =
      leftType.udonType === UdonType.UInt64 &&
      rightType.udonType === UdonType.UInt64
        ? PrimitiveTypes.uint32
        : PrimitiveTypes.int32;
  } else if (leftIsLong) {
    narrowTarget =
      rightType.udonType === UdonType.UInt32
        ? PrimitiveTypes.uint32
        : PrimitiveTypes.int32;
  } else {
    narrowTarget =
      leftType.udonType === UdonType.UInt32
        ? PrimitiveTypes.uint32
        : PrimitiveTypes.int32;
  }

  let newLeft = left;
  let newRight = right;
  if (leftIsLong) {
    const cast = converter.newTemp(narrowTarget);
    converter.emit(new CastInstruction(cast, left));
    newLeft = cast;
  }
  if (rightIsLong) {
    const cast = converter.newTemp(narrowTarget);
    converter.emit(new CastInstruction(cast, right));
    newRight = cast;
  }
  return { left: newLeft, right: newRight };
}

function resolvePropertyTypeFromType(
  converter: ASTToTACConverter,
  baseType: TypeSymbol,
  property: string,
  visited: Set<string> = new Set(),
): TypeSymbol | null {
  // Track visited alias names so a multi-step cycle (`A -> B -> A`) cannot
  // recurse forever — the direct `aliasedType !== baseType` check below only
  // catches single-step self-reference. Bound the recursion explicitly.
  const aliasedType = converter.typeMapper.getAlias(baseType.name);
  if (
    aliasedType &&
    aliasedType !== baseType &&
    !visited.has(aliasedType.name)
  ) {
    visited.add(aliasedType.name);
    const aliasedProperty = resolvePropertyTypeFromType(
      converter,
      aliasedType,
      property,
      visited,
    );
    if (aliasedProperty) return aliasedProperty;
  }

  if (baseType instanceof ArrayTypeSymbol && property === "length") {
    return PrimitiveTypes.int32;
  }

  if (baseType instanceof InterfaceTypeSymbol) {
    return baseType.properties.get(property) ?? null;
  }

  if (converter.classRegistry) {
    const classMeta = converter.classRegistry.getClass(baseType.name);
    if (classMeta) {
      const prop = converter.classRegistry.getMergedProperty(
        baseType.name,
        property,
      );
      if (prop) {
        return prop.type;
      }
    } else {
      const interfaceMeta = converter.classRegistry.getInterface(baseType.name);
      const prop = interfaceMeta?.properties.find(
        (candidate) => candidate.name === property,
      );
      if (prop) {
        return prop.type;
      }
    }
  }

  const classNode = converter.classMap.get(baseType.name);
  const prop = classNode?.properties.find(
    (candidate) => candidate.name === property,
  );
  if (prop) return prop.type;

  // Consult type metadata registry for extern/stub types (e.g. DataToken, DataList)
  const metadata = typeMetadataRegistry.getMemberMetadata(
    baseType.name,
    property,
  );
  if (metadata && metadata.kind === "property") {
    return mapCSharpTypeToTypeSymbol(metadata.returnCsharpType);
  }

  return null;
}

// isPlainObjectType is imported from type_symbols.js

export function resolveTypeFromNode(
  converter: ASTToTACConverter,
  node: ASTNode,
): TypeSymbol | null {
  // TypeChecker-first resolution when we have a bridged ts.Node.
  // The constructor pairs checkerContext with checkerTypeResolver, so
  // checking both here is just TypeScript narrowing, not a runtime branch.
  // Routed through `resolveFromAstNode` so the resolver's astNodeCache
  // short-circuits repeated visits of the same syntactic node — inline
  // expansion in particular re-visits each call site once per inline copy.
  if (converter.checkerContext && converter.checkerTypeResolver) {
    try {
      const resolved = converter.checkerTypeResolver.resolveFromAstNode(
        node,
        converter.checkerContext,
      );
      if (resolved && resolved !== ObjectType) {
        return resolved;
      }
    } catch (e) {
      if (e instanceof TranspileError) throw e;
      // Non-fatal: fall through to legacy resolution path
    }
  }

  switch (node.kind) {
    case ASTNodeKind.ThisExpression:
      return converter.currentClassName
        ? new ClassTypeSymbol(converter.currentClassName, UdonType.Object)
        : null;
    case ASTNodeKind.Identifier: {
      const symbol = converter.symbolTable.lookup(
        (node as IdentifierNode).name,
      );
      // If the symbol has a concrete/non-generic type, return it. Otherwise
      // fall back to resolving from the initializer AST when available.
      if (
        symbol?.declaredType &&
        (symbol.declaredType instanceof ArrayTypeSymbol ||
          symbol.declaredType instanceof DataListTypeSymbol)
      ) {
        return symbol.declaredType;
      }
      if (symbol?.type && symbol.type !== ObjectType) return symbol.type;
      if (symbol?.initialValue) {
        return resolveTypeFromNode(converter, symbol.initialValue as ASTNode);
      }
      return null;
    }
    case ASTNodeKind.PropertyAccessExpression: {
      const access = node as PropertyAccessExpressionNode;
      const baseType = resolveTypeFromNode(converter, access.object);
      if (!baseType) return null;
      return resolvePropertyTypeFromType(converter, baseType, access.property);
    }
    case ASTNodeKind.OptionalChainingExpression: {
      const access = node as OptionalChainingExpressionNode;
      const baseType = resolveTypeFromNode(converter, access.object);
      if (!baseType) return null;
      return resolvePropertyTypeFromType(converter, baseType, access.property);
    }
    case ASTNodeKind.ArrayAccessExpression: {
      const access = node as ArrayAccessExpressionNode;
      const arrayType = resolveTypeFromNode(converter, access.array);
      if (arrayType instanceof ArrayTypeSymbol) {
        return arrayType.peelOneDimension();
      }
      if (arrayType instanceof CollectionTypeSymbol) {
        return arrayType.valueType ?? arrayType.elementType ?? ObjectType;
      }
      if (arrayType instanceof DataListTypeSymbol) {
        return arrayType.elementType;
      }
      if (arrayType?.name === ExternTypes.dataList.name) {
        return ObjectType;
      }
      return null;
    }
    case ASTNodeKind.CallExpression: {
      // Resolve the return type of a call expression from the callee's
      // method declaration. Handles `ClassName.method()` and `obj.method()`.
      const call = node as CallExpressionNode;
      if (call.callee.kind === ASTNodeKind.PropertyAccessExpression) {
        const pa = call.callee as PropertyAccessExpressionNode;
        const baseType = resolveTypeFromNode(converter, pa.object);
        if (baseType && baseType !== ObjectType) {
          const ret = resolveMethodReturnType(converter, baseType, pa.property);
          if (ret) return ret;
        }
        // Static method on a class name: e.g. Tile.parse("1m")
        // Check classMap/classRegistry directly since typeMapper may map
        // inline class names to ObjectType. Pass isStatic=true so the
        // classMap fallback finds static methods.
        if (pa.object.kind === ASTNodeKind.Identifier) {
          const className = (pa.object as IdentifierNode).name;
          const isKnownClass =
            converter.classMap.has(className) ||
            !!converter.classRegistry?.getClass(className);
          if (isKnownClass) {
            const syntheticType = new ClassTypeSymbol(
              className,
              UdonType.Int32,
            );
            return resolveMethodReturnType(
              converter,
              syntheticType,
              pa.property,
              true,
            );
          }
        }
      }
      if (call.callee.kind === ASTNodeKind.OptionalChainingExpression) {
        const opt = call.callee as OptionalChainingExpressionNode;
        const baseType = resolveTypeFromNode(converter, opt.object);
        if (baseType && baseType !== ObjectType) {
          const ret = resolveMethodReturnType(
            converter,
            baseType,
            opt.property,
            false,
          );
          if (ret) return ret;
        }
      }
      return null;
    }
    default:
      return null;
  }
}

function resolveDeclaredTypeFromNode(
  converter: ASTToTACConverter,
  node: ASTNode,
): TypeSymbol | null {
  if (node.kind === ASTNodeKind.Identifier) {
    const symbol = converter.symbolTable.lookup((node as IdentifierNode).name);
    return symbol?.declaredType ?? symbol?.type ?? null;
  }
  if (node.kind === ASTNodeKind.AsExpression) {
    return resolveDeclaredTypeFromNode(
      converter,
      (node as AsExpressionNode).expression,
    );
  }
  return null;
}

/**
 * Resolve the return type of a method on a given base type.
 * For inline class return types (not known extern types), creates a
 * ClassTypeSymbol so callers can identify the concrete class.
 *
 * @param isStatic - When set, restricts the classMap fallback to static
 *   (true) or instance (false) methods. When undefined, tries instance
 *   first, then static (the classRegistry path via getMergedMethods does
 *   not filter by static, so it already covers both).
 */
export function resolveMethodReturnType(
  converter: ASTToTACConverter,
  baseType: TypeSymbol,
  methodName: string,
  isStatic?: boolean,
): TypeSymbol | null {
  const typeName = baseType.name;
  if (!typeName) return null;

  if (
    methodName === "includes" &&
    (baseType instanceof ArrayTypeSymbol ||
      baseType instanceof DataListTypeSymbol ||
      baseType instanceof NativeArrayTypeSymbol ||
      baseType.udonType === ExternTypes.dataList.udonType)
  ) {
    return PrimitiveTypes.boolean;
  }

  // Check class registry for inline classes.
  // getMergedMethods does not filter by static, so both instance and static
  // methods are found regardless of the isStatic hint.
  if (converter.classRegistry) {
    const classMeta = converter.classRegistry.getClass(typeName);
    if (classMeta) {
      const method = converter.classRegistry.getMergedMethod(
        typeName,
        methodName,
      );
      if (method) {
        return resolveInlineOrAliasType(converter, method.returnType);
      }
    }
    const ifaceMeta = converter.classRegistry.getInterface(typeName);
    if (ifaceMeta) {
      const method = ifaceMeta.methods.find((m) => m.name === methodName);
      if (method) {
        return resolveInlineOrAliasType(converter, method.returnType);
      }
    }
  }
  if (baseType instanceof InterfaceTypeSymbol) {
    const method = baseType.methods.get(methodName);
    if (method) {
      return resolveInlineOrAliasType(converter, method.returnType);
    }
  }
  // Check class map (AST nodes) — walk inheritance chain via resolveClassMethod
  // to handle methods defined on base classes. Pipe through resolveInlineClassType
  // when the return type is available so inline class return types get
  // upgraded from ObjectType to ClassTypeSymbol (consistent with classRegistry
  // paths). Try the specified isStatic value first; when unspecified, try
  // instance then static so both Tile.fromCode() and tile.toString() resolve.
  const resolveFromClassMap = (staticFlag: boolean): TypeSymbol | null => {
    const resolved = resolveClassMethod(
      converter,
      typeName,
      methodName,
      staticFlag,
    );
    if (resolved) {
      return resolveInlineOrAliasType(converter, resolved.method.returnType);
    }
    return null;
  };

  if (isStatic !== undefined) {
    return resolveFromClassMap(isStatic);
  }
  return resolveFromClassMap(false) ?? resolveFromClassMap(true);
}

function resolveIteratorValueTypeFromNextCall(
  converter: ASTToTACConverter,
  nextCallNode: ASTNode,
): TypeSymbol | null {
  if (nextCallNode.kind !== ASTNodeKind.CallExpression) return null;
  const nextCall = nextCallNode as CallExpressionNode;
  if (
    nextCall.arguments.length !== 0 ||
    nextCall.callee.kind !== ASTNodeKind.PropertyAccessExpression
  ) {
    return null;
  }
  const nextAccess = nextCall.callee as PropertyAccessExpressionNode;
  if (nextAccess.property !== "next") return null;

  const iterableExpr = nextAccess.object;
  const iterableType = resolveTypeFromNode(converter, iterableExpr);
  if (iterableType instanceof DataListTypeSymbol) {
    return iterableType.elementType;
  }
  if (iterableType instanceof ArrayTypeSymbol) {
    return iterableType.peelOneDimension();
  }

  if (iterableExpr.kind !== ASTNodeKind.CallExpression) return null;
  const iterableCall = iterableExpr as CallExpressionNode;
  if (
    iterableCall.arguments.length !== 0 ||
    iterableCall.callee.kind !== ASTNodeKind.PropertyAccessExpression
  ) {
    return null;
  }

  const iterableAccess = iterableCall.callee as PropertyAccessExpressionNode;
  const collectionType = resolveTypeFromNode(converter, iterableAccess.object);
  if (!collectionType) return null;

  if (
    collectionType instanceof CollectionTypeSymbol &&
    isMapCollectionType(collectionType)
  ) {
    switch (iterableAccess.property) {
      case "keys":
        return (collectionType.keyType as TypeSymbol | undefined) ?? null;
      case "values":
        return (collectionType.valueType as TypeSymbol | undefined) ?? null;
      case "entries":
        return ExternTypes.dataToken;
      default:
        return null;
    }
  }

  if (
    isSetCollectionType(collectionType) &&
    (iterableAccess.property === "keys" || iterableAccess.property === "values")
  ) {
    return (collectionType.elementType as TypeSymbol | undefined) ?? null;
  }

  return null;
}

function flattenStringConcatChain(
  converter: ASTToTACConverter,
  node: BinaryExpressionNode,
): ASTNode[] | null {
  if (node.operator !== "+") return null;
  const parts: ASTNode[] = [];

  const recurse = (n: ASTNode): boolean => {
    if (n.kind === ASTNodeKind.BinaryExpression) {
      const bn = n as BinaryExpressionNode;
      if (bn.operator !== "+") return false;
      const lType = resolveTypeFromNode(converter, bn.left);
      const rType = resolveTypeFromNode(converter, bn.right);
      const lIsString = lType?.udonType === UdonType.String;
      const rIsString = rType?.udonType === UdonType.String;
      if (!lIsString && !rIsString) return false;
      if (!recurse(bn.left)) return false;
      if (!recurse(bn.right)) return false;
      return true;
    }
    parts.push(n);
    return true;
  };

  if (!recurse(node)) return null;
  return parts;
}

const STRINGBUILDER_FQ = "System.Text.StringBuilder";
const stringBuilderTypeCache = new WeakMap<TypeMapper, TypeSymbol>();
function getStringBuilderType(typeMapper: TypeMapper): TypeSymbol {
  let cached = stringBuilderTypeCache.get(typeMapper);
  if (!cached) {
    cached = typeMapper.resolveByBareName("StringBuilder");
    stringBuilderTypeCache.set(typeMapper, cached);
  }
  return cached;
}

function generateStringBuilderConcat(
  converter: ASTToTACConverter,
  parts: TACOperand[],
): TACOperand {
  const builderType = getStringBuilderType(converter.typeMapper);
  const builder = converter.newTemp(builderType);
  const ctorSig = converter.requireExternSignature(
    STRINGBUILDER_FQ,
    "ctor",
    "method",
    [],
    STRINGBUILDER_FQ,
  );
  converter.emit(new CallInstruction(builder, ctorSig, []));
  for (const partOperand of parts) {
    converter.emit(
      new MethodCallInstruction(undefined, builder, "Append", [partOperand]),
    );
  }
  const result = converter.newTemp(PrimitiveTypes.string);
  converter.emit(new MethodCallInstruction(result, builder, "ToString", []));
  return result;
}

export function visitExpression(
  this: ASTToTACConverter,
  node: ASTNode,
): TACOperand {
  switch (node.kind) {
    case ASTNodeKind.BinaryExpression:
      return this.visitBinaryExpression(node as BinaryExpressionNode);
    case ASTNodeKind.UnaryExpression:
      return this.visitUnaryExpression(node as UnaryExpressionNode);
    case ASTNodeKind.UpdateExpression:
      return this.visitUpdateExpression(node as UpdateExpressionNode);
    case ASTNodeKind.ConditionalExpression:
      return this.visitConditionalExpression(node as ConditionalExpressionNode);
    case ASTNodeKind.NullCoalescingExpression:
      return this.visitNullCoalescingExpression(
        node as NullCoalescingExpressionNode,
      );
    case ASTNodeKind.NameofExpression:
      return this.visitNameofExpression(node as NameofExpressionNode);
    case ASTNodeKind.TypeofExpression:
      return this.visitTypeofExpression(node as TypeofExpressionNode);
    case ASTNodeKind.OptionalChainingExpression:
      return this.visitOptionalChainingExpression(
        node as OptionalChainingExpressionNode,
      );
    case ASTNodeKind.TemplateExpression:
      return this.visitTemplateExpression(node as TemplateExpressionNode);
    case ASTNodeKind.ArrayLiteralExpression:
      return this.visitArrayLiteralExpression(
        node as ArrayLiteralExpressionNode,
      );
    case ASTNodeKind.Literal:
      return this.visitLiteral(node as LiteralNode);
    case ASTNodeKind.Identifier:
      return this.visitIdentifier(node as IdentifierNode);
    case ASTNodeKind.ObjectLiteralExpression:
      return this.visitObjectLiteralExpression(
        node as ObjectLiteralExpressionNode,
      );
    case ASTNodeKind.DeleteExpression:
      return this.visitDeleteExpression(node as DeleteExpressionNode);
    case ASTNodeKind.SuperExpression:
      return this.visitSuperExpression(node as SuperExpressionNode);
    case ASTNodeKind.CallExpression:
      return this.visitCallExpression(node as CallExpressionNode);
    case ASTNodeKind.AsExpression:
      return this.visitAsExpression(node as AsExpressionNode);
    case ASTNodeKind.AssignmentExpression:
      return this.visitAssignmentExpression(node as AssignmentExpressionNode);
    case ASTNodeKind.PropertyAccessExpression:
      return this.visitPropertyAccessExpression(
        node as PropertyAccessExpressionNode,
      );
    case ASTNodeKind.ArrayAccessExpression:
      return this.visitArrayAccessExpression(node as ArrayAccessExpressionNode);
    case ASTNodeKind.ThisExpression:
      return this.visitThisExpression(node as ThisExpressionNode);
    case ASTNodeKind.FunctionExpression:
      throw new Error(
        "Function expressions are only supported as Set.forEach callbacks.",
      );
    default:
      throw new Error(`Unsupported expression kind: ${node.kind}`);
  }
}

export function visitBinaryExpression(
  this: ASTToTACConverter,
  node: BinaryExpressionNode,
): TACOperand {
  if (node.operator === "===") {
    node = { ...node, operator: "==" };
  } else if (node.operator === "!==") {
    node = { ...node, operator: "!=" };
  }
  const compoundOps: Record<string, string> = {
    "+=": "+",
    "-=": "-",
    "*=": "*",
    "/=": "/",
    "%=": "%",
    "&=": "&",
    "|=": "|",
    "^=": "^",
  };
  if (compoundOps[node.operator]) {
    const leftOriginal = this.visitExpression(node.left);
    // Inject the LHS type as expected context for the RHS so that numeric
    // literals inside the RHS (e.g. `arr[i] += 1 + 2`) stay in the integer
    // lane rather than defaulting to Double.
    const leftOriginalType = this.getOperandType(leftOriginal);
    const prevExpectedTypeCompound = this.currentExpectedType;
    if (
      leftOriginalType instanceof PrimitiveTypeSymbol &&
      NUMERIC_UDON_TYPES.has(leftOriginalType.udonType)
    ) {
      this.currentExpectedType = leftOriginalType;
    }
    let rightOriginal: TACOperand;
    try {
      rightOriginal = this.visitExpression(node.right);
    } finally {
      this.currentExpectedType = prevExpectedTypeCompound;
    }
    const baseOp = compoundOps[node.operator];
    // compoundOps does not contain <<= or >>=, so no shift guard needed.
    // C# compound assignment: x op= y ≡ x = (T)(x op y), where T = typeof(x).
    const isBitwiseCompound =
      baseOp === "&" || baseOp === "|" || baseOp === "^";
    const isRemainderCompound = baseOp === "%";
    let preWidenLeft = leftOriginal;
    let preWidenRight = rightOriginal;
    if (isRemainderCompound) {
      const nr = narrowLongForRemainder(
        this,
        node,
        leftOriginal,
        rightOriginal,
      );
      preWidenLeft = nr.left;
      preWidenRight = nr.right;
    }
    const w = isBitwiseCompound
      ? narrowToInt32ForBitwise(this, preWidenLeft, preWidenRight)
      : widenNumericOperands(this, preWidenLeft, preWidenRight);
    const opResult = this.newTemp(this.getOperandType(w.left));
    this.emit(new BinaryOpInstruction(opResult, w.left, baseOp, w.right));

    let assignValue: TACOperand = opResult;
    // Narrow back to the original left operand's type if promotion widened it.
    if (w.left !== leftOriginal) {
      const narrowed = this.newTemp(this.getOperandType(leftOriginal));
      this.emit(new CastInstruction(narrowed, opResult));
      assignValue = narrowed;
    }

    if (leftOriginal.kind === TACOperandKind.Variable) {
      const target = leftOriginal as VariableOperand;
      // When the read came from `evaluateInlineGetter` (or any other
      // inlined method body), the returned variable is an
      // `__inline_ret_*` temporary disconnected from the backing
      // storage — writing to it would silently drop the
      // compound-assigned value. The `isInlineReturn` flag is set by
      // `inlineResolvedMethodBody` at creation time, so the check stays
      // robust if the temp's naming convention ever changes. Plain
      // field reads return a Variable that is itself the SoA-backed
      // storage, so the fast path remains correct for non-getter LHS
      // and does not re-evaluate `node.left`'s object expression
      // (important for side-effecting LHS such as `getBox().value += 1`).
      if (target.isInlineReturn) {
        // `node.left` must be a PropertyAccessExpression here: a plain
        // identifier or method call cannot produce an isInlineReturn
        // Variable that reaches the compound-assignment LHS slot — only
        // getter-inlined property reads do, because methods are invoked
        // via CallExpression (not PropertyAccess) as the assign target.
        // We already evaluated the LHS fully (including any side effects
        // in `node.left.object`); calling `assignToTarget` here would
        // re-visit that object expression, double-firing effects such
        // as `getBox()`. Emit the diagnostic directly and drop the
        // write — the assignment semantics match
        // `maybeWarnWriteToGetter`'s short-circuit, without the
        // re-evaluation.
        if (node.left.kind === ASTNodeKind.PropertyAccessExpression) {
          const propAccess = node.left as PropertyAccessExpressionNode;
          this.warnAt(
            propAccess,
            "WriteToGetter",
            `Compound write to getter-backed property "${propAccess.property}" — TS normally rejects this, so reaching this point indicates a transpiler-synthesized write. The write is being dropped to avoid resurrecting the phantom-slot bug.`,
          );
          return assignValue;
        }
        // All isInlineReturn creation sites (see `isInlineReturn: true`
        // in helpers/inline.ts and visitors/call.ts) produce the flag on
        // return slots of inlined method/getter bodies. Only getter
        // reads — which are PropertyAccessExpression nodes — can surface
        // such a Variable as a compound-assignment LHS; methods reach
        // the LHS slot via CallExpression, not PropertyAccess, so they
        // land on the non-Variable branch below. If this line ever
        // fires, some future inlining path produced an isInlineReturn
        // Variable from a non-PropertyAccess expression and the silent
        // assignToTarget fallback would re-evaluate `node.left`,
        // duplicating side effects. Fail loudly instead.
        throw new Error(
          `Internal error: isInlineReturn Variable on compound-assignment LHS of unexpected AST kind ${ASTNodeKind[node.left.kind]}. Expected PropertyAccessExpression — investigate the inlining path that produced this operand.`,
        );
      }
      this.emitCopyWithTracking(target, assignValue);
      return assignValue;
    }

    return this.assignToTarget(node.left, assignValue);
  }
  if (node.operator === "**") {
    let left = this.visitExpression(node.left);
    let right = this.visitExpression(node.right);
    if (this.getOperandType(left).udonType !== UdonType.Double) {
      const castLeft = this.newTemp(PrimitiveTypes.double);
      this.emit(new CastInstruction(castLeft, left));
      left = castLeft;
    }
    if (this.getOperandType(right).udonType !== UdonType.Double) {
      const castRight = this.newTemp(PrimitiveTypes.double);
      this.emit(new CastInstruction(castRight, right));
      right = castRight;
    }
    const result = this.newTemp(PrimitiveTypes.double);
    const externSig = this.resolveStaticExtern("SystemMath", "Pow", "method");
    if (!externSig) {
      throw new Error("System.Math.Pow extern signature not found");
    }
    this.emit(new CallInstruction(result, externSig, [left, right]));
    return result;
  }
  if (node.operator === "instanceof") {
    return createConstant(false, PrimitiveTypes.boolean);
  }
  if (node.operator === "in") {
    const key = this.visitExpression(node.left);
    const target = this.visitExpression(node.right);
    const targetType = this.getOperandType(target);
    if (targetType.name === ExternTypes.dataDictionary.name) {
      const result = this.newTemp(PrimitiveTypes.boolean);
      const keyToken = this.wrapDataToken(key);
      this.emit(
        new MethodCallInstruction(result, target, "ContainsKey", [keyToken]),
      );
      return result;
    }
    return createConstant(false, PrimitiveTypes.boolean);
  }
  if (node.operator === ">>>") {
    const left = this.visitExpression(node.left);
    const right = this.visitExpression(node.right);

    // Capture constant shift amount BEFORE float-narrowing (e.g. `>>> 1.0`
    // would cast the constant to a Temporary, losing the literal value).
    let constShiftAmount: number | null = null;
    if (right.kind === TACOperandKind.Constant) {
      const rawVal = (right as ConstantOperand).value;
      if (typeof rawVal === "number") {
        constShiftAmount = Math.trunc(rawVal);
      } else if (typeof rawVal === "bigint") {
        constShiftAmount = Number(rawVal);
      }
    }

    let narrowedLeft = left;
    const leftType = this.getOperandType(left);
    if (BITWISE_FLOAT_TYPES.has(leftType.udonType)) {
      const cast = this.newTemp(PrimitiveTypes.int32);
      this.emit(new CastInstruction(cast, left));
      narrowedLeft = cast;
    }

    const narrowedLeftType = this.getOperandType(narrowedLeft);

    // Lowering is only safe when the left operand is in the Int32 domain (the
    // 32-bit mask & shift semantics are undefined for wider/unsigned types).
    if (narrowedLeftType.udonType === UdonType.Int32) {
      // a >>> 0  →  identity (unsigned cast, same bit pattern as Int32).
      // Check before narrowing the right operand to avoid emitting a dead
      // CastInstruction for float zero literals like `>>> 0.0`.
      if (constShiftAmount === 0) {
        return narrowedLeft;
      }

      // a >>> b  (1 ≤ b ≤ 31, constant)
      // Lowering: (a >> b) & (0x7FFFFFFF >> (b-1))
      //   – signed >>  fills the top b bits with the old sign bit
      //   – the mask zeroes those sign-extension bits, leaving the correct
      //     unsigned-shift result as a non-negative Int32 value
      if (
        constShiftAmount !== null &&
        constShiftAmount >= 1 &&
        constShiftAmount <= 31
      ) {
        // Narrow right operand only when it will actually be used.
        let narrowedRight = right;
        const rightType = this.getOperandType(right);
        if (BITWISE_FLOAT_TYPES.has(rightType.udonType)) {
          const castR = this.newTemp(PrimitiveTypes.int32);
          this.emit(new CastInstruction(castR, right));
          narrowedRight = castR;
        }
        const mask = (0x7fffffff >> (constShiftAmount - 1)) | 0;
        const shifted = this.newTemp(PrimitiveTypes.int32);
        this.emit(
          new BinaryOpInstruction(shifted, narrowedLeft, ">>", narrowedRight),
        );
        const result = this.newTemp(PrimitiveTypes.int32);
        this.emit(
          new BinaryOpInstruction(
            result,
            shifted,
            "&",
            createConstant(mask, PrimitiveTypes.int32),
          ),
        );
        return result;
      }
    }

    // Fallback for unsupported cases: variable shift amount, constant shift
    // amount outside [0, 31], or non-Int32 left operand.  Emit a signed >> as
    // a best-effort approximation and warn so the user can rewrite manually.
    let narrowedRight = right;
    const rightType = this.getOperandType(right);
    if (BITWISE_FLOAT_TYPES.has(rightType.udonType)) {
      const castR = this.newTemp(PrimitiveTypes.int32);
      this.emit(new CastInstruction(castR, right));
      narrowedRight = castR;
    }
    let warnMessage: string;
    if (narrowedLeftType.udonType !== UdonType.Int32) {
      warnMessage = `Unsigned right shift (>>>) on non-Int32 type (${narrowedLeftType.udonType}) is not supported; using signed >> instead.`;
    } else if (constShiftAmount !== null) {
      warnMessage = `Unsigned right shift (>>>) with constant shift amount ${constShiftAmount} is out of the supported range [0, 31]; using signed >> instead.`;
    } else {
      warnMessage =
        "Unsigned right shift (>>>) with a non-constant shift amount is not fully supported; using signed >> instead. Extract the shift amount to a constant to enable automatic lowering.";
    }
    this.warnAt(node, "UnsupportedOperator", warnMessage);
    const resultType = narrowedLeftType;
    const result = this.newTemp(resultType);
    this.emit(
      new BinaryOpInstruction(result, narrowedLeft, ">>", narrowedRight),
    );
    return result;
  }
  if (node.operator === "&&") {
    return this.visitShortCircuitAnd(node);
  }
  if (node.operator === "||") {
    return this.visitShortCircuitOr(node);
  }
  // Attempt to detect chained string concatenation (a + b + c ...)
  // Only run the chain flattener when useStringBuilder is true;
  // otherwise the pairwise string-concat fallback below handles it.
  if (node.operator === "+" && this.useStringBuilder) {
    const chain = flattenStringConcatChain(this, node);
    if (chain) {
      const partsOperands: TACOperand[] = [];
      for (const partNode of chain) {
        let partOperand: TACOperand;
        if (
          partNode.kind === ASTNodeKind.Literal &&
          (partNode as LiteralNode).type.udonType === UdonType.String
        ) {
          const lit = partNode as LiteralNode;
          const litVal = lit.value ?? "";
          if (String(litVal).length === 0) continue;
          partOperand = createConstant(String(litVal), PrimitiveTypes.string);
        } else {
          const exprResult = this.visitExpression(partNode);
          const exprType = this.getOperandType(exprResult);
          if (exprType.udonType === UdonType.String) {
            partOperand = exprResult;
          } else {
            partOperand = this.newTemp(PrimitiveTypes.string);
            this.emit(
              new MethodCallInstruction(
                partOperand,
                exprResult,
                "ToString",
                [],
              ),
            );
          }
        }
        partsOperands.push(partOperand);
      }
      if (partsOperands.length === 0) {
        return createConstant("", PrimitiveTypes.string);
      }
      if (partsOperands.length >= this.stringBuilderThreshold) {
        return generateStringBuilderConcat(this, partsOperands);
      }
      // Below threshold: build a String.Concat chain directly to avoid re-visiting
      let resultOperand: TACOperand = partsOperands[0];
      for (let i = 1; i < partsOperands.length; i += 1) {
        const partOperand = partsOperands[i];
        const newResult = this.newTemp(PrimitiveTypes.string);
        const concatExtern = this.requireExternSignature(
          "System.String",
          "Concat",
          "method",
          ["string", "string"],
          "System.String",
        );
        this.emit(
          new CallInstruction(newResult, concatExtern, [
            resultOperand,
            partOperand,
          ]),
        );
        resultOperand = newResult;
      }
      return resultOperand;
    }
  }
  // flattenStringConcatChain uses resolveTypeFromNode (read-only type
  // inspection) and never calls visitExpression, so visiting left/right
  // here does not double-evaluate any sub-expression.
  let left = this.visitExpression(node.left);
  // Cross-propagate: if the left operand resolved to a non-float integer
  // type and no integer expected type is already in scope, temporarily
  // inject it for the right operand visit so that numeric literals on
  // the right (e.g. `intVar + 1`) are created as integers rather than
  // Double and avoid unnecessary widening.
  const leftTypeCross = this.getOperandType(left);
  let right: TACOperand;
  if (
    leftTypeCross instanceof PrimitiveTypeSymbol &&
    NUMERIC_UDON_TYPES.has(leftTypeCross.udonType) &&
    !FLOAT_UDON_TYPES.has(leftTypeCross.udonType) &&
    !(
      this.currentExpectedType instanceof PrimitiveTypeSymbol &&
      NUMERIC_UDON_TYPES.has(this.currentExpectedType.udonType) &&
      !FLOAT_UDON_TYPES.has(this.currentExpectedType.udonType)
    )
  ) {
    const prevCross = this.currentExpectedType;
    this.currentExpectedType = leftTypeCross;
    try {
      right = this.visitExpression(node.right);
    } finally {
      this.currentExpectedType = prevCross;
    }
  } else {
    right = this.visitExpression(node.right);
  }

  const dataTokenNullishComparison = tryEmitDataTokenNullishComparison(
    this,
    left,
    right,
    node.operator,
  );
  if (dataTokenNullishComparison !== null) {
    return dataTokenNullishComparison;
  }

  if (
    node.operator === "==" ||
    node.operator === "!=" ||
    node.operator === "===" ||
    node.operator === "!=="
  ) {
    const leftType = this.getOperandType(left);
    const rightType = this.getOperandType(right);
    if (isNullishOperand(right) && !isNullishOperand(left)) {
      // For inline-handle leftType, normalise the LHS to its Int32 handle so
      // both sides of the comparison are Int32 (matches the `-1` sentinel
      // retargeted RHS).
      if (usesInlineNullSentinel(this, leftType)) {
        left = normalizeOperandToInt32(this, left);
      }
      right = retargetNullishComparisonOperand(this, right, leftType);
    } else if (isNullishOperand(left) && !isNullishOperand(right)) {
      if (usesInlineNullSentinel(this, rightType)) {
        right = normalizeOperandToInt32(this, right);
      }
      left = retargetNullishComparisonOperand(this, left, rightType);
    }
  }

  // Determine result type - comparison operators return Boolean
  const isComparison = [
    "<",
    ">",
    "<=",
    ">=",
    "==",
    "!=",
    "===",
    "!==",
  ].includes(node.operator);
  // String concatenation with mixed types: call ToString on non-string operand.
  // Entry conditions:
  //   (a) useStringBuilder is false → chain detection skipped entirely; all
  //       string + non-string binary exprs are handled here.
  //   (b) useStringBuilder is true AND flattenStringConcatChain returned null
  //       (e.g., left sub-expr like `(intA + intB)` has no string-typed leaf).
  // Note: leftType/rightType are only used inside this block (which returns early).
  {
    const leftType = this.getOperandType(left);
    const rightType = this.getOperandType(right);
    if (
      node.operator === "+" &&
      (leftType.udonType === UdonType.String ||
        rightType.udonType === UdonType.String)
    ) {
      if (leftType.udonType !== UdonType.String) {
        const strLeft = this.newTemp(PrimitiveTypes.string);
        this.emit(new MethodCallInstruction(strLeft, left, "ToString", []));
        left = strLeft;
      }
      if (rightType.udonType !== UdonType.String) {
        const strRight = this.newTemp(PrimitiveTypes.string);
        this.emit(new MethodCallInstruction(strRight, right, "ToString", []));
        right = strRight;
      }
      const concatExtern = this.requireExternSignature(
        "System.String",
        "Concat",
        "method",
        ["string", "string"],
        "System.String",
      );
      const result = this.newTemp(PrimitiveTypes.string);
      this.emit(new CallInstruction(result, concatExtern, [left, right]));
      return result;
    }
  }

  const isBitwise =
    node.operator === "|" || node.operator === "&" || node.operator === "^";
  const isShift = node.operator === "<<" || node.operator === ">>";
  const isRemainder = node.operator === "%";

  if (isBitwise) {
    // Narrow to Int32 for bitwise ops — Udon VM has no float bitwise EXTERNs.
    const n = narrowToInt32ForBitwise(this, left, right);
    left = n.left;
    right = n.right;
  } else if (isShift) {
    // Narrow to Int32 for shift ops — Udon VM requires integer operands for
    // shift EXTERNs (e.g. SystemInt32.__op_RightShift__). Float left operands
    // produce invalid signatures like SystemSingle.__op_RightShift__.
    // Also narrow the right operand for consistency (shift count should be Int32).
    const leftType = this.getOperandType(left);
    const rightType = this.getOperandType(right);
    if (BITWISE_FLOAT_TYPES.has(leftType.udonType)) {
      const cast = this.newTemp(PrimitiveTypes.int32);
      this.emit(new CastInstruction(cast, left));
      left = cast;
    }
    if (BITWISE_FLOAT_TYPES.has(rightType.udonType)) {
      const cast = this.newTemp(PrimitiveTypes.int32);
      this.emit(new CastInstruction(cast, right));
      right = cast;
    }
  } else if (isRemainder) {
    const nr = narrowLongForRemainder(this, node, left, right);
    left = nr.left;
    right = nr.right;
    const w = widenNumericOperands(this, left, right);
    left = w.left;
    right = w.right;
  } else {
    // Widen narrower operand when both are numeric and types differ (skip shifts).
    const w = widenNumericOperands(this, left, right);
    left = w.left;
    right = w.right;
  }

  const resultType = isComparison
    ? PrimitiveTypes.boolean
    : this.getOperandType(left);
  const result = this.newTemp(resultType);

  this.emit(new BinaryOpInstruction(result, left, node.operator, right));
  return result;
}

function tryEmitDataTokenNullishComparison(
  converter: ASTToTACConverter,
  left: TACOperand,
  right: TACOperand,
  operator: string,
): TACOperand | null {
  if (
    operator !== "==" &&
    operator !== "!=" &&
    operator !== "===" &&
    operator !== "!=="
  ) {
    return null;
  }

  const leftType = converter.getOperandType(left);
  const rightType = converter.getOperandType(right);
  let token: TACOperand | null = null;

  if (leftType.udonType === UdonType.DataToken && isNullishOperand(right)) {
    token = left;
  } else if (
    rightType.udonType === UdonType.DataToken &&
    isNullishOperand(left)
  ) {
    token = right;
  }
  if (token === null) return null;

  const isNull = converter.newTemp(PrimitiveTypes.boolean);
  converter.emit(new PropertyGetInstruction(isNull, token, "IsNull"));
  if (operator === "==" || operator === "===") {
    return isNull;
  }

  const result = converter.newTemp(PrimitiveTypes.boolean);
  converter.emit(new UnaryOpInstruction(result, "!", isNull));
  return result;
}

function isNullishOperand(operand: TACOperand): boolean {
  return operand.kind === TACOperandKind.Constant
    ? (operand as ConstantOperand).value === null
    : false;
}

function retargetNullishComparisonOperand(
  converter: ASTToTACConverter,
  operand: TACOperand,
  targetType: TypeSymbol,
): TACOperand {
  if (!isNullishOperand(operand)) return operand;
  // Inline-handle types store null as the sentinel `-1` Int32, not as an
  // Object reference. Without this branch, `inlineHandle == null` lowers to
  // op_Equality(Int32, Object) — mismatched operand types, comparison never
  // matches the missing-instance case. Mirrors visitNullCoalescingExpression
  // and visitOptionalChainingExpression's sentinel handling.
  if (usesInlineNullSentinel(converter, targetType)) {
    return createConstant(-1, PrimitiveTypes.int32);
  }
  // Always type the null constant to the target type so the comparison
  // operands match. For non-nullable types (e.g. Int32, Boolean) this path
  // should normally be unreachable because the TS frontend rejects
  // `primitive == null`, but if it does reach TAC we avoid a type-mismatch
  // extern by using a typed constant instead of an untyped Object null.
  return createConstant(null, targetType);
}

function coerceNullishValueForResultType(
  converter: ASTToTACConverter,
  operand: TACOperand,
  resultType: TypeSymbol,
): TACOperand {
  if (!isNullishOperand(operand)) return operand;
  if (usesInlineNullSentinel(converter, resultType)) {
    return createConstant(-1, PrimitiveTypes.int32);
  }
  return createConstant(null, resultType);
}

export function visitShortCircuitAnd(
  this: ASTToTACConverter,
  node: BinaryExpressionNode,
): TACOperand {
  const endLabel = this.newLabel("and_end");

  const left = this.visitExpression(node.left);
  const coercedLeft = this.coerceToBoolean(left);
  const result = this.newTemp(PrimitiveTypes.boolean);
  this.emit(
    new AssignmentInstruction(
      result,
      createConstant(false, PrimitiveTypes.boolean),
    ),
  );
  this.emit(new ConditionalJumpInstruction(coercedLeft, endLabel));

  const right = this.visitExpression(node.right);
  this.emitCopyWithTracking(result, this.coerceToBoolean(right));
  this.emit(new LabelInstruction(endLabel));
  return result;
}

export function visitShortCircuitOr(
  this: ASTToTACConverter,
  node: BinaryExpressionNode,
): TACOperand {
  // Reject Boolean and any Object-shaped expectedType (incl. ClassTypeSymbol
  // with udonType=Object that leaks in via inline expansion). Without this
  // check the bool result of comparisons would be copied into an %SystemObject
  // slot — a width/shape mismatch that corrupts downstream reads.
  const expectedType =
    this.currentExpectedType &&
    this.currentExpectedType.udonType !== UdonType.Boolean &&
    this.currentExpectedType.udonType !== UdonType.Object
      ? this.currentExpectedType
      : undefined;
  const inferredLeftType = resolveTypeFromNode(this, node.left);
  const inferredRightType = resolveTypeFromNode(this, node.right);
  const valueResultType =
    expectedType ??
    (inferredLeftType?.udonType !== UdonType.Boolean
      ? inferredLeftType
      : undefined) ??
    (inferredRightType?.udonType !== UdonType.Boolean
      ? inferredRightType
      : undefined);

  if (valueResultType && valueResultType.udonType !== UdonType.Boolean) {
    const rightLabel = this.newLabel("or_right");
    const endLabel = this.newLabel("or_end");

    const left = this.visitExpression(node.left);
    const result = this.newTemp(valueResultType);
    const coercedLeft = this.coerceToBoolean(left);
    this.emit(new ConditionalJumpInstruction(coercedLeft, rightLabel));

    this.emitCopyWithTracking(
      result,
      coerceLogicalValue(this, left, valueResultType),
    );
    this.emit(new UnconditionalJumpInstruction(endLabel));

    this.emit(new LabelInstruction(rightLabel));
    const prevExpectedType = this.currentExpectedType;
    this.currentExpectedType = valueResultType;
    let right: TACOperand;
    try {
      right = this.visitExpression(node.right);
    } finally {
      this.currentExpectedType = prevExpectedType;
    }
    this.emitCopyWithTracking(
      result,
      coerceLogicalValue(this, right, valueResultType),
    );
    this.emit(new LabelInstruction(endLabel));
    const resultKey = operandTrackingKey(result);
    if (
      resultKey &&
      valueResultType &&
      isTrackedInlineHandleType(this, valueResultType)
    ) {
      this.inlineInstanceMap.delete(resultKey);
    }
    return result;
  }

  const result = this.newTemp(PrimitiveTypes.boolean);
  const shortCircuitLabel = this.newLabel("or_short");
  const endLabel = this.newLabel("or_end");

  const left = this.visitExpression(node.left);
  const coercedLeft = this.coerceToBoolean(left);
  this.emit(new ConditionalJumpInstruction(coercedLeft, shortCircuitLabel));

  this.emit(
    new AssignmentInstruction(
      result,
      createConstant(true, PrimitiveTypes.boolean),
    ),
  );
  this.emit(new UnconditionalJumpInstruction(endLabel));

  this.emit(new LabelInstruction(shortCircuitLabel));
  const right = this.visitExpression(node.right);
  this.emitCopyWithTracking(result, this.coerceToBoolean(right));
  this.emit(new LabelInstruction(endLabel));
  return result;
}

function coerceLogicalValue(
  converter: ASTToTACConverter,
  value: TACOperand,
  targetType: TypeSymbol,
): TACOperand {
  let coerced = value;
  const valueType = converter.getOperandType(coerced);
  if (
    valueType.udonType === UdonType.DataToken &&
    targetType.udonType !== UdonType.DataToken
  ) {
    coerced = converter.unwrapDataToken(coerced, targetType);
  }
  const coercedType = converter.getOperandType(coerced);
  // Numeric ↔ numeric and Boolean → numeric both need an explicit cast: a
  // mixed-type expression like `someInt || someFlag` derives `targetType` from
  // the int side but the right branch can still evaluate to Boolean. Without
  // this cast the bool would be copied into the int-typed result slot,
  // producing a type-mismatched TAC.
  const sourceIsCoercibleToNumeric =
    NUMERIC_UDON_TYPES.has(coercedType.udonType) ||
    coercedType.udonType === UdonType.Boolean;
  if (
    coercedType.udonType !== targetType.udonType &&
    sourceIsCoercibleToNumeric &&
    NUMERIC_UDON_TYPES.has(targetType.udonType)
  ) {
    const cast = converter.newTemp(targetType);
    converter.emit(new CastInstruction(cast, coerced));
    return cast;
  }
  return coerced;
}

export function visitUnaryExpression(
  this: ASTToTACConverter,
  node: UnaryExpressionNode,
): TACOperand {
  const rawOperand = this.visitExpression(node.operand);
  const operand =
    node.operator === "!" ? this.coerceToBoolean(rawOperand) : rawOperand;
  // Logical NOT always produces Boolean regardless of operand type.
  // This ensures coerceToBoolean sees Boolean and skips redundant coercion.
  const resultType =
    node.operator === "!"
      ? PrimitiveTypes.boolean
      : this.getOperandType(operand);
  const result = this.newTemp(resultType);

  this.emit(new UnaryOpInstruction(result, node.operator, operand));
  return result;
}

export function visitConditionalExpression(
  this: ASTToTACConverter,
  node: ConditionalExpressionNode,
): TACOperand {
  const condition = this.coerceToBoolean(this.visitExpression(node.condition));
  const falseLabel = this.newLabel("cond_false");
  const endLabel = this.newLabel("cond_end");

  this.emit(new ConditionalJumpInstruction(condition, falseLabel));

  const trueVal = this.visitExpression(node.whenTrue);
  const result = this.newTemp(this.getOperandType(trueVal));
  // Plain copy: the shared result temp is written from two diverging
  // branches — tracking would retain only the last-written branch's
  // prefix, producing incorrect property resolution for the other branch.
  this.emit(new CopyInstruction(result, trueVal));
  this.emit(new UnconditionalJumpInstruction(endLabel));

  this.emit(new LabelInstruction(falseLabel));
  const falseVal = this.visitExpression(node.whenFalse);
  // Upgrade result type if the false branch provides a more specific
  // non-primitive reference type. Only upgrade for types that benefit from
  // inline dispatch (ArrayTypeSymbol, InterfaceTypeSymbol, CollectionTypeSymbol).
  // Primitive types (int, float, bool, string) must not override ObjectType
  // because the true branch may hold an incompatible boxed value.
  if (result.kind === TACOperandKind.Temporary) {
    const falseType = this.getOperandType(falseVal);
    if (
      (result as TemporaryOperand).type === ObjectType &&
      falseType !== ObjectType &&
      (falseType instanceof ArrayTypeSymbol ||
        falseType instanceof InterfaceTypeSymbol ||
        falseType instanceof CollectionTypeSymbol ||
        falseType instanceof DataListTypeSymbol)
    ) {
      (result as TemporaryOperand).type = falseType;
    }
  }
  this.emit(new CopyInstruction(result, falseVal)); // Plain copy: see true-branch comment above.
  this.emit(new LabelInstruction(endLabel));
  return result;
}

export function visitNullCoalescingExpression(
  this: ASTToTACConverter,
  node: NullCoalescingExpressionNode,
): TACOperand {
  const expected = this.currentExpectedType;
  const savedExpectedType = this.currentExpectedType;
  const left = this.visitExpression(node.left);
  this.currentExpectedType = savedExpectedType;
  const leftType = this.getOperandType(left);
  const resultType =
    expected &&
    !isPlainObjectType(expected) &&
    leftType.udonType === UdonType.DataToken
      ? expected
      : leftType;
  const result = this.newTemp(resultType);
  const notNullLabel = this.newLabel("null_not");
  const endLabel = this.newLabel("null_end");

  const isNull = this.newTemp(PrimitiveTypes.boolean);
  if (usesInlineNullSentinel(this, leftType)) {
    const leftHandle = normalizeOperandToInt32(this, left);
    this.emit(
      new BinaryOpInstruction(
        isNull,
        leftHandle,
        "==",
        createConstant(-1, PrimitiveTypes.int32),
      ),
    );
  } else {
    // Box typed-slot left operand into Object before the null compare so the
    // BinaryOp lowers to SystemObject.op_Equality with matched operand types.
    // Without this, a `DataList`/`Array`/interface-typed `left` produces a
    // mismatched-operand compare that may not detect a null reference
    // reliably across Udon runtime versions. Same pattern as
    // visitOptionalChainingExpression and the optional-chain method-call
    // null check in call.ts.
    const nullCheckOperand = this.newTemp(ObjectType);
    this.emit(new CopyInstruction(nullCheckOperand, left));
    this.emit(
      new BinaryOpInstruction(
        isNull,
        nullCheckOperand,
        "==",
        createConstant(null, ObjectType),
      ),
    );
  }
  this.emit(new ConditionalJumpInstruction(isNull, notNullLabel));

  const right = this.visitExpression(node.right);
  // Upgrade result type if the right operand provides a more specific
  // non-primitive reference type. Same guard as visitConditionalExpression.
  if (result.kind === TACOperandKind.Temporary) {
    const rightType = this.getOperandType(right);
    if (
      ((result as TemporaryOperand).type === ObjectType ||
        (result as TemporaryOperand).type.udonType === UdonType.DataToken) &&
      rightType !== ObjectType &&
      (leftType === ObjectType ||
        leftType.udonType === UdonType.Object ||
        rightType instanceof ArrayTypeSymbol ||
        rightType instanceof InterfaceTypeSymbol ||
        rightType instanceof CollectionTypeSymbol ||
        rightType instanceof DataListTypeSymbol)
    ) {
      (result as TemporaryOperand).type = rightType;
    }
  }
  // Plain copy: same shared-result reasoning as visitConditionalExpression.
  const resultFinalType = this.getOperandType(result);
  const rightValue = isNullishOperand(right)
    ? coerceNullishValueForResultType(this, right, resultFinalType)
    : this.getOperandType(right).udonType === UdonType.DataToken &&
        resultFinalType.udonType !== UdonType.DataToken
      ? this.unwrapDataToken(right, resultFinalType)
      : right;
  this.emit(new CopyInstruction(result, rightValue));
  this.emit(new UnconditionalJumpInstruction(endLabel));

  this.emit(new LabelInstruction(notNullLabel));
  const leftValue = isNullishOperand(left)
    ? coerceNullishValueForResultType(this, left, resultFinalType)
    : this.getOperandType(left).udonType === UdonType.DataToken &&
        resultFinalType.udonType !== UdonType.DataToken
      ? this.unwrapDataToken(left, resultFinalType)
      : left;
  this.emit(new CopyInstruction(result, leftValue)); // Plain copy: see null-path comment above.
  this.emit(new LabelInstruction(endLabel));
  return result;
}

export function visitTemplateExpression(
  this: ASTToTACConverter,
  node: TemplateExpressionNode,
): TACOperand {
  const mergedParts = this.mergeTemplateParts(node.parts);
  const folded = this.tryFoldTemplateExpression(mergedParts);
  if (folded) {
    return folded;
  }
  const parts: TACOperand[] = [];
  for (const part of mergedParts) {
    let partOperand: TACOperand;
    if (part.kind === "text") {
      if (part.value.length === 0) {
        continue;
      }
      partOperand = createConstant(part.value, PrimitiveTypes.string);
    } else {
      const exprResult = this.visitExpression(part.expression);
      const exprType = this.getOperandType(exprResult);
      if (exprType.udonType === UdonType.String) {
        partOperand = exprResult;
      } else {
        partOperand = this.newTemp(PrimitiveTypes.string);
        this.emit(
          new MethodCallInstruction(partOperand, exprResult, "ToString", []),
        );
      }
    }
    parts.push(partOperand);
  }

  if (parts.length === 0) {
    return createConstant("", PrimitiveTypes.string);
  }

  if (this.useStringBuilder && parts.length >= this.stringBuilderThreshold) {
    const builderType = getStringBuilderType(this.typeMapper);
    const builder = this.newTemp(builderType);
    const ctorSig = this.requireExternSignature(
      STRINGBUILDER_FQ,
      "ctor",
      "method",
      [],
      STRINGBUILDER_FQ,
    );
    this.emit(new CallInstruction(builder, ctorSig, []));
    for (const partOperand of parts) {
      this.emit(
        new MethodCallInstruction(undefined, builder, "Append", [partOperand]),
      );
    }
    const result = this.newTemp(PrimitiveTypes.string);
    this.emit(new MethodCallInstruction(result, builder, "ToString", []));
    return result;
  }

  let result: TACOperand = parts[0];
  for (let i = 1; i < parts.length; i += 1) {
    const partOperand = parts[i];
    const newResult = this.newTemp(PrimitiveTypes.string);
    const concatExtern = this.requireExternSignature(
      "System.String",
      "Concat",
      "method",
      ["string", "string"],
      "System.String",
    );
    this.emit(
      new CallInstruction(newResult, concatExtern, [result, partOperand]),
    );
    result = newResult;
  }
  return result;
}

function resolveSpreadArrayType(
  converter: ASTToTACConverter,
  node: ASTNode,
): ArrayTypeSymbol | null {
  let resolved = resolveTypeFromNode(converter, node);
  if (!resolved && node.kind === ASTNodeKind.PropertyAccessExpression) {
    const access = node as PropertyAccessExpressionNode;
    if (access.object.kind === ASTNodeKind.Identifier) {
      const ident = access.object as IdentifierNode;
      const sym = converter.symbolTable.lookup(ident.name);
      if (sym?.type) {
        resolved = resolvePropertyTypeFromType(
          converter,
          sym.type,
          access.property,
        );
      }
    }
    if (
      !resolved &&
      access.object.kind === ASTNodeKind.ThisExpression &&
      converter.currentClassName
    ) {
      const classNode = converter.classMap.get(converter.currentClassName);
      const prop = classNode?.properties.find(
        (p) => p.name === access.property,
      );
      if (prop) resolved = prop.type;
    }
  }
  return resolved instanceof ArrayTypeSymbol ? resolved : null;
}

function resolveInlineOrAliasType(
  converter: ASTToTACConverter,
  type: TypeSymbol,
): TypeSymbol {
  const inlineType = resolveInlineClassType(converter, type);
  return converter.typeMapper.getAlias(inlineType.name) ?? inlineType;
}

function inlineInstanceDeclaresProperty(
  converter: ASTToTACConverter,
  className: string,
  property: string,
): boolean {
  if (resolveClassProperty(converter, className, property)) return true;
  const alias = converter.typeMapper.getAlias(className);
  return alias instanceof InterfaceTypeSymbol
    ? alias.properties.has(property)
    : false;
}

function tryReadInlineFieldByHandle(
  converter: ASTToTACConverter,
  handle: TACOperand,
  property: string,
  propertyType: TypeSymbol,
): TACOperand | null {
  const candidates: Array<[number, string]> = [];
  for (const [instanceId, info] of converter.allInlineInstances) {
    if (inlineInstanceDeclaresProperty(converter, info.className, property)) {
      candidates.push([instanceId, info.prefix]);
    }
  }
  if (
    candidates.length === 0 &&
    converter.fieldTypeRegistry.getStructuralFieldType(property) !== undefined
  ) {
    converter.warnAt(
      undefined,
      "D3DispatchFallback",
      `Imprecise inline field read for property "${property}" — using all ${converter.allInlineInstances.size} inline instance(s) as dispatch candidates.`,
    );
    for (const [instanceId, info] of converter.allInlineInstances) {
      candidates.push([instanceId, info.prefix]);
    }
  }
  if (candidates.length === 0) return null;

  const result = converter.newTemp(propertyType);
  converter.emit(
    new AssignmentInstruction(
      result,
      createSoaSentinelValue(converter, propertyType),
    ),
  );
  // Normalize the handle to Int32 before comparing against instance-id
  // constants. When `handle` arrives as an Object slot (e.g. an `__opt_base_*`
  // built from an erased optional-chain receiver), `==` with an Int32 constant
  // would lower to `SystemObject.op_Equality` — a *reference* comparison
  // between two distinct boxes — and never matches even when the boxed
  // values are equal. Forcing the cast first routes through SystemInt32
  // equality and matches the D-3 untracked-handle dispatch path.
  const handleInt32 = normalizeOperandToInt32(converter, handle);
  const endLabel = converter.newLabel("inline_field_handle_end");
  for (const [, prefix] of candidates) {
    const nextLabel = converter.newLabel("inline_field_handle_next");
    const matches = converter.newTemp(PrimitiveTypes.boolean);
    converter.emit(
      new BinaryOpInstruction(
        matches,
        handleInt32,
        "==",
        createVariable(`${prefix}__handle`, PrimitiveTypes.int32),
      ),
    );
    converter.emit(new ConditionalJumpInstruction(matches, nextLabel));
    converter.emit(
      new CopyInstruction(
        result,
        createVariable(`${prefix}_${property}`, propertyType),
      ),
    );
    converter.emit(new UnconditionalJumpInstruction(endLabel));
    converter.emit(new LabelInstruction(nextLabel));
  }
  converter.emit(new LabelInstruction(endLabel));
  return result;
}

export function visitArrayLiteralExpression(
  this: ASTToTACConverter,
  node: ArrayLiteralExpressionNode,
): TACOperand {
  // Typed array spread concat optimization:
  // [...arr1, ...arr2] where all sources are typed arrays → arr1.concat(arr2)
  if (
    node.elements.length >= 2 &&
    node.elements.every((e) => e.kind === "spread")
  ) {
    const resolvedTypes: ArrayTypeSymbol[] = [];
    let allTypedArrays = true;
    for (const elem of node.elements) {
      const resolved = resolveSpreadArrayType(this, elem.value);
      if (resolved) {
        resolvedTypes.push(resolved);
      } else {
        allTypedArrays = false;
        break;
      }
    }

    if (allTypedArrays) {
      let baseType = resolvedTypes[0];
      if (node.typeHint instanceof ArrayTypeSymbol) {
        baseType = node.typeHint;
      }
      const allCompatible = resolvedTypes.every((t) =>
        t.isAssignableTo(baseType),
      );
      if (allCompatible) {
        const operands = node.elements.map((e) =>
          this.visitExpression(e.value),
        );
        // Udon VM does not have a native Array.concat extern.
        // Implement concat as: allocate new array, copy elements from each.
        let result = operands[0];
        for (let i = 1; i < operands.length; i++) {
          result = emitArrayConcat(this, result, operands[i]);
        }
        return result;
      }
    }
  }

  const expectedArrayElementType = this.currentExpectedType
    ? extractArrayLiteralHint(this.currentExpectedType)
    : undefined;
  let spreadElementType: TypeSymbol | undefined;
  if (
    !node.typeHint &&
    !expectedArrayElementType &&
    node.elements.length > 0 &&
    node.elements.every((e) => e.kind === "spread")
  ) {
    const spreadTypes = node.elements.map((element) =>
      resolveTypeFromNode(this, element.value),
    );
    const spreadElementTypes = spreadTypes
      .map((type) => {
        if (type instanceof ArrayTypeSymbol) return type.elementType;
        if (type instanceof DataListTypeSymbol) return type.elementType;
        if (type instanceof NativeArrayTypeSymbol) return type.elementType;
        return undefined;
      })
      .filter((type): type is TypeSymbol => type !== undefined);
    if (spreadElementTypes.length === node.elements.length) {
      const firstElementType = spreadElementTypes[0];
      if (spreadElementTypes.every((type) => type.isAssignableTo(firstElementType))) {
        spreadElementType = firstElementType;
      }
    }
  }
  const elementType =
    node.typeHint ?? expectedArrayElementType ?? spreadElementType ?? ObjectType;

  // Native fixed-length array path: emit when the variable is eligible and
  // all elements are non-spread, so the length is known at compile time.
  if (
    this.currentNativeArrayVarName !== null &&
    node.elements.length > 0 &&
    node.elements.every((e) => e.kind === "element") &&
    getNativeArrayTypeName(elementType.udonType) !== null
  ) {
    // Integer-literal narrowing: when the declared element type is Double
    // (TypeScript `number[]`) and every literal in the initialiser is an
    // integral value that fits in Int32, use Int32Array instead.  This avoids
    // the Double ↔ Int32 round-trip conversions on every subsequent read/write.
    let resolvedElementType: TypeSymbol = elementType;
    if (
      elementType.udonType === UdonType.Double &&
      node.elements.every(
        (e) =>
          e.value.kind === ASTNodeKind.Literal &&
          typeof (e.value as LiteralNode).value === "number" &&
          Number.isInteger((e.value as LiteralNode).value as number) &&
          valueFitsInIntegerType(
            (e.value as LiteralNode).value as number,
            UdonType.Int32,
          ),
      )
    ) {
      resolvedElementType = PrimitiveTypes.int32;
    }
    const nativeType = new NativeArrayTypeSymbol(resolvedElementType);
    const arrayResult = this.newTemp(nativeType);
    const ctorSig = this.requireExternSignature(
      nativeType.nativeUdonTypeName,
      "ctor",
      "method",
      ["int"],
      nativeType.nativeUdonTypeName,
    );
    const lengthConst = createConstant(
      node.elements.length,
      PrimitiveTypes.int32,
    );
    this.emit(new CallInstruction(arrayResult, ctorSig, [lengthConst]));
    for (let i = 0; i < node.elements.length; i++) {
      const prevExpected = this.currentExpectedType;
      this.currentExpectedType = resolvedElementType;
      let value: TACOperand;
      try {
        value = this.visitExpression(node.elements[i].value);
      } finally {
        this.currentExpectedType = prevExpected;
      }
      const idxConst = createConstant(i, PrimitiveTypes.int32);
      this.emit(new ArrayAssignmentInstruction(arrayResult, idxConst, value));
    }
    return arrayResult;
  }

  const listResult = this.newTemp(new DataListTypeSymbol(elementType));
  const externSig = this.requireExternSignature(
    "DataList",
    "ctor",
    "method",
    [],
    "DataList",
  );
  this.emit(new CallInstruction(listResult, externSig, []));

  for (const element of node.elements) {
    if (element.kind === "spread") {
      const spreadValue = this.visitExpression(element.value);
      let spreadType = this.getOperandType(spreadValue);
      let isDataList =
        spreadType.udonType === UdonType.DataList ||
        spreadType.name === ExternTypes.dataList.name;
      let isArray = spreadType.udonType === UdonType.Array;
      if (!isDataList && !isArray) {
        let resolvedType = resolveTypeFromNode(this, element.value);
        // Additional fallback: if resolveTypeFromNode couldn't determine the
        // property type for a PropertyAccessExpression, try looking up the
        // base identifier in the current symbol table or the current class
        // properties. This helps in cases like `ponMeld.tiles` where the
        // identifier has a declared type but the node-level resolver missed it.
        if (
          !resolvedType &&
          element.value.kind === ASTNodeKind.PropertyAccessExpression
        ) {
          const access = element.value as PropertyAccessExpressionNode;
          // If base is an identifier, try symbol table
          if (access.object.kind === ASTNodeKind.Identifier) {
            const ident = access.object as IdentifierNode;
            const sym = this.symbolTable.lookup(ident.name);
            if (sym?.type) {
              resolvedType = resolvePropertyTypeFromType(
                this,
                sym.type,
                access.property,
              );
            }
            // If the symbol was created with an initializer AST, try resolving
            // the property type from that initializer as a fallback.
            if (!resolvedType && sym?.initialValue) {
              const initResolved = resolveTypeFromNode(
                this,
                sym.initialValue as ASTNode,
              );
              if (initResolved) {
                resolvedType = resolvePropertyTypeFromType(
                  this,
                  initResolved,
                  access.property,
                );
              }
            }
          }
          // If base is `this`, try current class declaration
          if (
            !resolvedType &&
            access.object.kind === ASTNodeKind.ThisExpression &&
            this.currentClassName
          ) {
            const classNode = this.classMap.get(this.currentClassName);
            const prop = classNode?.properties.find(
              (p) => p.name === access.property,
            );
            if (prop) resolvedType = prop.type;
          }
        }
        if (resolvedType) {
          if (
            resolvedType instanceof DataListTypeSymbol ||
            resolvedType.name === ExternTypes.dataList.name
          ) {
            spreadType = resolvedType;
            isDataList = true;
          } else if (resolvedType instanceof ArrayTypeSymbol) {
            spreadType = resolvedType;
            isArray = true;
          }
        }
      }
      if (!isDataList && !isArray) {
        const describeNode = (n: ASTNode, depth = 0): string => {
          if (depth > 50) return "...";
          switch (n.kind) {
            case ASTNodeKind.Identifier:
              return (n as IdentifierNode).name;
            case ASTNodeKind.PropertyAccessExpression: {
              const p = n as PropertyAccessExpressionNode;
              return `${describeNode(p.object, depth + 1)}.${p.property}`;
            }
            case ASTNodeKind.ArrayAccessExpression: {
              const a = n as ArrayAccessExpressionNode;
              return `${describeNode(a.array, depth + 1)}[${describeNode(
                a.index,
                depth + 1,
              )}]`;
            }
            case ASTNodeKind.CallExpression: {
              const c = n as CallExpressionNode;
              return `${describeNode(c.callee, depth + 1)}(...)`;
            }
            case ASTNodeKind.BinaryExpression: {
              const b = n as BinaryExpressionNode;
              return `${describeNode(b.left, depth + 1)} ${b.operator} ${describeNode(
                b.right,
                depth + 1,
              )}`;
            }
            case ASTNodeKind.UnaryExpression: {
              const u = n as UnaryExpressionNode;
              return `${u.operator}${describeNode(u.operand, depth + 1)}`;
            }
            case ASTNodeKind.Literal: {
              const lit = n as LiteralNode;
              return String(lit.value);
            }
            default:
              return String(n.kind);
          }
        };

        const buildSymbolDiag = (
          identName: string,
          s: SymbolInfo | undefined,
        ): string => {
          if (!s) return "";
          const tname = s.type?.name ?? "<unknown>";
          const inits = s.initialValue
            ? describeNode(s.initialValue as ASTNode)
            : "<none>";
          return `; symbol(${identName})={type:${tname},initial:${inits}}`;
        };

        const sourceHint = describeNode(element.value);
        const spreadTypeName = spreadType ? `${spreadType.name}` : "<unknown>";
        const spreadUdon = spreadType ? `${spreadType.udonType}` : "<unknown>";

        // Diagnostic details: if the spread expression is a property access,
        // include info about the base expression resolution and any symbol info
        let diag = "";
        if (element.value.kind === ASTNodeKind.PropertyAccessExpression) {
          const access = element.value as PropertyAccessExpressionNode;
          const baseDesc = describeNode(access.object);
          const baseResolved = resolveTypeFromNode(this, access.object);
          const baseResolvedName = baseResolved
            ? baseResolved.name
            : "<unknown>";
          diag += `; base=${baseDesc} -> ${baseResolvedName}`;
          if (access.object.kind === ASTNodeKind.Identifier) {
            const ident = access.object as IdentifierNode;
            diag += buildSymbolDiag(
              ident.name,
              this.symbolTable.lookup(ident.name),
            );
          }
        } else if (element.value.kind === ASTNodeKind.Identifier) {
          const ident = element.value as IdentifierNode;
          diag += buildSymbolDiag(
            ident.name,
            this.symbolTable.lookup(ident.name),
          );
        }

        throw new Error(
          `Array spread expects an Array or DataList (spread expression "${sourceHint}" resolved to ${spreadTypeName} (${spreadUdon})${diag})`,
        );
      }

      const indexVar = this.newTemp(PrimitiveTypes.int32);
      const lengthVar = this.newTemp(PrimitiveTypes.int32);
      this.emit(
        new AssignmentInstruction(
          indexVar,
          createConstant(0, PrimitiveTypes.int32),
        ),
      );
      // All arrays (both DataList and ArrayTypeSymbol) use Count at runtime.
      const countSpread = ensureDataListForCount(this, spreadValue);
      this.emit(new PropertyGetInstruction(lengthVar, countSpread, "Count"));

      const loopStart = this.newLabel("array_spread_start");
      const loopContinue = this.newLabel("array_spread_continue");
      const loopEnd = this.newLabel("array_spread_end");

      this.emit(new LabelInstruction(loopStart));
      const condTemp = this.newTemp(PrimitiveTypes.boolean);
      this.emit(new BinaryOpInstruction(condTemp, indexVar, "<", lengthVar));
      this.emit(new ConditionalJumpInstruction(condTemp, loopEnd));

      // All arrays use DataList.get_Item at runtime → returns DataToken.
      const itemToken = this.newTemp(ExternTypes.dataToken);
      this.emit(
        new MethodCallInstruction(itemToken, spreadValue, "get_Item", [
          indexVar,
        ]),
      );
      // DataList.Add expects DataToken — pass directly, no wrap/unwrap needed.
      const token = itemToken;
      this.emit(
        new MethodCallInstruction(undefined, listResult, "Add", [token]),
      );

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
      continue;
    }
    const prevExpected = this.currentExpectedType;
    this.currentExpectedType = elementType;
    let value: TACOperand;
    try {
      value = this.visitExpression(element.value);
    } finally {
      this.currentExpectedType = prevExpected;
    }
    const token = this.wrapDataToken(value);
    this.emit(new MethodCallInstruction(undefined, listResult, "Add", [token]));
  }

  return listResult;
}

export function visitLiteral(
  this: ASTToTACConverter,
  node: LiteralNode,
): TACOperand {
  const expected = this.currentExpectedType;
  // Phase B-1: demote a `number` literal to the integer expected type only
  // when (a) the value is integral and (b) it fits the target's representable
  // range. This bypasses the implicit Double→Int32 SystemConvert when the
  // literal is provably safe. bigint values stay on the Int64 path; out-of-
  // range / non-integer numbers fall through to the regular Cast pipeline.
  if (
    typeof node.value === "number" &&
    expected &&
    Number.isInteger(node.value) &&
    valueFitsInIntegerType(node.value, expected.udonType)
  ) {
    return createConstant(node.value, expected);
  }
  return createConstant(node.value, node.type);
}

function valueFitsInIntegerType(value: number, t: UdonType): boolean {
  switch (t) {
    case UdonType.Byte:
      return value >= 0 && value <= 255;
    case UdonType.SByte:
      return value >= -128 && value <= 127;
    case UdonType.Int16:
      return value >= -32_768 && value <= 32_767;
    case UdonType.UInt16: // also Char
      return value >= 0 && value <= 65_535;
    case UdonType.Int32:
      return value >= -2_147_483_648 && value <= 2_147_483_647;
    case UdonType.UInt32:
      return value >= 0 && value <= 4_294_967_295;
    default:
      // Single/Double/Object/Int64/UInt64/etc. — no demote
      return false;
  }
}

export function visitIdentifier(
  this: ASTToTACConverter,
  node: IdentifierNode,
): TACOperand {
  if (node.name === "undefined") {
    return createConstant(null, ObjectType);
  }
  const symbol = this.symbolTable.lookup(node.name);
  if (!symbol) {
    if (
      this.classMap.has(node.name) ||
      this.udonBehaviourClasses.has(node.name) ||
      typeMetadataRegistry.hasType(node.name) ||
      node.name === "UdonTypeConverters" ||
      node.name === "Object" ||
      node.name === "Number" ||
      node.name === "BigInt" ||
      node.name === "Math" ||
      node.name === "Array" ||
      node.name === "Error" ||
      node.name === "console" ||
      node.name === "process" ||
      node.name === "Date" ||
      node.name === "JSON"
    ) {
      return createVariable(node.name, ObjectType);
    }
    if (this.classRegistry) {
      const meta = this.classRegistry.getClass(node.name);
      if (meta && !this.classRegistry.isStub(node.name)) {
        this.classMap.set(node.name, meta.node);
        return createVariable(node.name, ObjectType);
      }
    }
    const location = this.currentClassName
      ? `${this.currentClassName}${this.currentMethodName ? `.${this.currentMethodName}` : ""}`
      : "<unknown>";
    throw new Error(`Undefined variable: ${node.name} in ${location}`);
  }

  // Inline top-level literal constants using the declared type
  if (
    symbol.isConstant &&
    (symbol.scope ?? 0) === 0 &&
    symbol.initialValue &&
    (symbol.initialValue as ASTNode).kind === ASTNodeKind.Literal
  ) {
    const literal = symbol.initialValue as LiteralNode;
    return createConstant(literal.value, symbol.type);
  }

  const exportName = this.currentParamExportMap.get(node.name);
  const isParameter = symbol.isParameter === true;
  const isExported = !!exportName;
  const isLocal = !isParameter && (symbol.scope ?? 0) > 0;
  // Locals declared inside an inlined method body have a mangled heap slot
  // name (set on the symbol at declaration time) so that two inlined
  // methods declaring a same-named local don't collide on a single typed
  // heap slot. Identifier lookups in the inlined body still find the
  // symbol by its original AST name; only the emitted variable operand
  // uses the mangled slot name.
  const variableName = exportName ?? symbol.heapSlotName ?? node.name;
  return createVariable(variableName, symbol.type, {
    isLocal,
    isParameter,
    isExported,
  });
}

/**
 * When true, emit runtime Count + bounds checks before DataList.get_Item.
 * Non-negative numeric literals skip (Bug 6); unary `+K` with K ≥ 0 matches that fast path.
 * Everything else (including negative literals, `-K`, dynamic indices) needs the guard.
 */
function needsDataListReadBoundsGuard(indexNode: ASTNode): boolean {
  if (indexNode.kind === ASTNodeKind.Literal) {
    const lit = indexNode as LiteralNode;
    if (typeof lit.value === "number") {
      return lit.value < 0;
    }
    return true;
  }
  if (indexNode.kind === ASTNodeKind.UnaryExpression) {
    const u = indexNode as UnaryExpressionNode;
    if (u.operator === "+" && u.operand.kind === ASTNodeKind.Literal) {
      const lit = u.operand as LiteralNode;
      if (typeof lit.value === "number" && lit.value >= 0) {
        return false;
      }
    }
  }
  return true;
}

/**
 * DataList-backed bracket read: (index >= 0) then Count + (index < Count) before get_Item.
 * Lower-bound first avoids a redundant Count read when index is negative (P2).
 * Two ifFalse jumps (no labels between Count and get_Item) — matches Bug 10 TAC detector.
 */
function emitDataListBracketRead(
  converter: ASTToTACConverter,
  array: TACOperand,
  coercedIndex: TACOperand,
  indexNode: ASTNode,
  elementType: TypeSymbol,
): TACOperand {
  const tokenResult = converter.newTemp(ExternTypes.dataToken);
  if (!needsDataListReadBoundsGuard(indexNode)) {
    converter.emit(
      new MethodCallInstruction(tokenResult, array, "get_Item", [coercedIndex]),
    );
    return tokenResult;
  }

  const zero = createConstant(0, PrimitiveTypes.int32);
  const geZero = converter.newTemp(PrimitiveTypes.boolean);
  converter.emit(new BinaryOpInstruction(geZero, coercedIndex, ">=", zero));
  const skipLabel = converter.newLabel("dlrd_oob");
  const mergeLabel = converter.newLabel("dlrd_merge");
  converter.emit(new ConditionalJumpInstruction(geZero, skipLabel));
  const countTemp = converter.newTemp(PrimitiveTypes.int32);
  const countArray = ensureDataListForCount(converter, array);
  converter.emit(new PropertyGetInstruction(countTemp, countArray, "Count"));
  const ltCount = converter.newTemp(PrimitiveTypes.boolean);
  converter.emit(
    new BinaryOpInstruction(ltCount, coercedIndex, "<", countTemp),
  );
  converter.emit(new ConditionalJumpInstruction(ltCount, skipLabel));
  converter.emit(
    new MethodCallInstruction(tokenResult, array, "get_Item", [coercedIndex]),
  );
  converter.emit(new UnconditionalJumpInstruction(mergeLabel));
  converter.emit(new LabelInstruction(skipLabel));
  const sentinelVal = createSoaSentinelValue(converter, elementType);
  const sentinelToken = converter.wrapDataToken(sentinelVal);
  converter.emit(new CopyInstruction(tokenResult, sentinelToken));
  converter.emit(new LabelInstruction(mergeLabel));
  return tokenResult;
}

export function visitArrayAccessExpression(
  this: ASTToTACConverter,
  node: ArrayAccessExpressionNode,
): TACOperand {
  const array = this.visitExpression(node.array);
  const arrayType = this.getOperandType(array);
  const resolvedArrayType = resolveTypeFromNode(this, node.array);
  const isDictionaryAccess =
    arrayType.name === ExternTypes.dataDictionary.name ||
    arrayType.udonType === UdonType.DataDictionary ||
    resolvedArrayType?.name === ExternTypes.dataDictionary.name ||
    resolvedArrayType?.udonType === UdonType.DataDictionary;
  const prevExpectedType = this.currentExpectedType;
  this.currentExpectedType = isDictionaryAccess
    ? undefined
    : PrimitiveTypes.int32;
  let index: TACOperand;
  try {
    index = this.visitExpression(node.index);
  } finally {
    this.currentExpectedType = prevExpectedType;
  }

  if (isDictionaryAccess) {
    const valueType =
      resolvedArrayType instanceof CollectionTypeSymbol
        ? (resolvedArrayType.valueType ?? ObjectType)
        : arrayType instanceof CollectionTypeSymbol
          ? (arrayType.valueType ?? ObjectType)
          : ObjectType;
    const keyToken = this.wrapDataToken(index);
    const tokenResult = this.newTemp(ExternTypes.dataToken);
    const hasKey = this.newTemp(PrimitiveTypes.boolean);
    const keyIsNull = this.newTemp(PrimitiveTypes.boolean);
    const keyNotNull = this.newTemp(PrimitiveTypes.boolean);
    const missingLabel = this.newLabel("dict_read_missing");
    const doneLabel = this.newLabel("dict_read_done");
    this.emit(new PropertyGetInstruction(keyIsNull, keyToken, "IsNull"));
    this.emit(
      new BinaryOpInstruction(
        keyNotNull,
        keyIsNull,
        "==",
        createConstant(false, PrimitiveTypes.boolean),
      ),
    );
    this.emit(new ConditionalJumpInstruction(keyNotNull, missingLabel));
    this.emit(
      new MethodCallInstruction(hasKey, array, "ContainsKey", [keyToken]),
    );
    this.emit(new ConditionalJumpInstruction(hasKey, missingLabel));
    this.emit(
      new MethodCallInstruction(tokenResult, array, "GetValue", [keyToken]),
    );
    this.emit(new UnconditionalJumpInstruction(doneLabel));
    this.emit(new LabelInstruction(missingLabel));
    const nullToken = this.wrapDataToken(createConstant(null, ObjectType));
    this.emit(new CopyInstruction(tokenResult, nullToken));
    this.emit(new LabelInstruction(doneLabel));
    const unwrapped = this.unwrapDataToken(tokenResult, valueType);
    if (unwrapped === tokenResult) {
      return tokenResult;
    }
    const resultType = resolveInlineClassType(this, valueType);
    const result = this.newTemp(resultType);
    this.emitCopyWithTracking(result, unwrapped);
    return result;
  }

  // Native array path: emit ArrayAccessInstruction (no DataToken unwrap needed).
  if (arrayType instanceof NativeArrayTypeSymbol) {
    const result = this.newTemp(arrayType.elementType);
    // Coerce index to Int32 (native array __Get__ expects SystemInt32).
    let nativeIndex = index;
    const nativeIndexType = this.getOperandType(index);
    if (needsInt32IndexCoercion(nativeIndexType.udonType)) {
      const intIndex = this.newTemp(PrimitiveTypes.int32);
      this.emit(new CastInstruction(intIndex, index));
      nativeIndex = intIndex;
    }
    this.emit(new ArrayAccessInstruction(result, array, nativeIndex));
    markUntrackedInlineInterfaceArrayElement(
      this,
      result,
      arrayType.elementType,
    );
    return result;
  }

  if (arrayType instanceof CollectionTypeSymbol) {
    const elementType =
      arrayType.valueType ?? arrayType.elementType ?? PrimitiveTypes.double;
    const result = this.newTemp(elementType);
    this.emit(new MethodCallInstruction(result, array, "get_Item", [index]));
    markUntrackedInlineInterfaceArrayElement(this, result, elementType);
    return result;
  }

  if (
    arrayType instanceof DataListTypeSymbol ||
    arrayType.name === ExternTypes.dataList.name
  ) {
    // Coerce index to Int32 for DataList.get_Item (expects SystemInt32)
    let coercedIndex = index;
    const indexType = this.getOperandType(index);
    if (needsInt32IndexCoercion(indexType.udonType)) {
      const intIndex = this.newTemp(PrimitiveTypes.int32);
      this.emit(new CastInstruction(intIndex, index));
      coercedIndex = intIndex;
    }
    const elementType =
      arrayType instanceof DataListTypeSymbol
        ? arrayType.elementType
        : ObjectType;
    const tokenResult = emitDataListBracketRead(
      this,
      array,
      coercedIndex,
      node.index,
      elementType,
    );
    if (arrayType instanceof DataListTypeSymbol) {
      const unwrapped = this.unwrapDataToken(tokenResult, elementType);
      // When unwrapDataToken bails out for an erased target (Object / generic
      // / DataToken), it returns the token unchanged. COPY-ing that DataToken
      // into a fresh `%SystemObject` slot rewrites the dest slot's
      // `StrongBox<T>` to `StrongBox<DataToken>` (per `UdonHeap.CopyHeapVariable`'s
      // type-mismatch fallback). A subsequent read of the dest as the
      // declared type then throws `HeapTypeMismatchException`. Skip the
      // tracking copy when the unwrap was a no-op.
      if (unwrapped === tokenResult) {
        return tokenResult;
      }
      const resultType = resolveInlineClassType(this, elementType);
      const result = this.newTemp(resultType);
      this.emitCopyWithTracking(result, unwrapped);
      markUntrackedInlineInterfaceArrayElement(this, result, elementType);
      return result;
    }
    return tokenResult;
  }

  // Current lowering policy routes ArrayTypeSymbol through DataList semantics:
  // get_Item + DataToken unwrap instead of typed native array Get/Set.
  let elementType = this.getArrayElementType(array);
  if (!elementType) {
    const resolvedArrayType = resolveTypeFromNode(this, node.array);
    if (resolvedArrayType instanceof ArrayTypeSymbol) {
      elementType = resolvedArrayType.peelOneDimension();
    } else if (resolvedArrayType instanceof CollectionTypeSymbol) {
      elementType =
        resolvedArrayType.valueType ??
        resolvedArrayType.elementType ??
        ObjectType;
    } else if (resolvedArrayType instanceof DataListTypeSymbol) {
      elementType = resolvedArrayType.elementType;
    } else if (resolvedArrayType?.name === ExternTypes.dataList.name) {
      elementType = ObjectType;
    }
  }
  const resolvedElementType = elementType ?? ObjectType;
  // Coerce index to Int32 for DataList.get_Item
  let coercedIndex = index;
  const idxType = this.getOperandType(index);
  if (needsInt32IndexCoercion(idxType.udonType)) {
    const intIndex = this.newTemp(PrimitiveTypes.int32);
    this.emit(new CastInstruction(intIndex, index));
    coercedIndex = intIndex;
  }
  const tokenResult = emitDataListBracketRead(
    this,
    array,
    coercedIndex,
    node.index,
    resolvedElementType,
  );
  const unwrapped = this.unwrapDataToken(tokenResult, resolvedElementType);
  // See note above: skip the tracking copy when unwrap is a no-op so we
  // don't COPY a DataToken into a wider non-DataToken slot and rewrite the
  // dest's StrongBox type.
  if (unwrapped === tokenResult) {
    return tokenResult;
  }
  const resultType = resolveInlineClassType(this, resolvedElementType);
  const result = this.newTemp(resultType);
  this.emitCopyWithTracking(result, unwrapped);
  markUntrackedInlineInterfaceArrayElement(this, result, resolvedElementType);
  return result;
}

export function visitPropertyAccessExpression(
  this: ASTToTACConverter,
  node: PropertyAccessExpressionNode,
): TACOperand {
  this.propertyAccessDepth += 1;
  if (this.propertyAccessDepth > 200) {
    throw new Error(
      `Property access recursion too deep at ${node.property} (${node.object.kind})`,
    );
  }
  try {
    if (
      node.object.kind === ASTNodeKind.Identifier &&
      this.enumRegistry.isEnum((node.object as IdentifierNode).name)
    ) {
      const enumName = (node.object as IdentifierNode).name;
      const value = this.enumRegistry.resolve(enumName, node.property);
      if (value !== undefined) {
        const kind = this.enumRegistry.getEnumKind(enumName);
        const type =
          kind === "string" ? PrimitiveTypes.string : PrimitiveTypes.int32;
        return createConstant(value, type);
      }
    }

    if (
      node.object.kind === ASTNodeKind.Identifier &&
      (node.object as IdentifierNode).name === "Number"
    ) {
      if (node.property === "NEGATIVE_INFINITY") {
        return createConstant(-3.4028235e38, PrimitiveTypes.single);
      }
      if (node.property === "POSITIVE_INFINITY") {
        return createConstant(3.4028235e38, PrimitiveTypes.single);
      }
    }

    const selfRef = this.tryResolveUnitySelfReference(node);
    if (selfRef) return selfRef;

    if (
      node.object.kind === ASTNodeKind.ThisExpression &&
      this.currentInlineContext &&
      !this.currentThisOverride
    ) {
      const { className, instancePrefix } = this.currentInlineContext;
      const getterResult = tryInlineGetter(
        this,
        className,
        instancePrefix,
        node.property,
      );
      if (getterResult !== undefined) return getterResult;
      // SoA path: for regular inlining the scratch is stale after multiple
      // loop iterations; reads must go through the per-field DataList indexed
      // by handle. tryReadSoAField returns undefined for __soa_mdisp_* and
      // soaConstructionPrefixes prefixes, so we fall through to scratch.
      const soaFieldResult = tryReadSoAField(
        this,
        instancePrefix,
        className,
        node.property,
      );
      if (soaFieldResult !== undefined) return soaFieldResult;
      const mapped = this.mapInlineProperty(
        className,
        instancePrefix,
        node.property,
      );
      if (mapped) {
        if (
          isInlineHandleType(this, mapped.type) &&
          !this.resolveInlineInstance(mapped.name)
        ) {
          const candidates = Array.from(this.allInlineInstances.values()).filter(
            (info) => info.className === mapped.type.name,
          );
          if (candidates.length === 1) {
            this.inlineInstanceMap.set(mapped.name, candidates[0]);
          }
        }
        return mapped;
      }
    }

    // Entry point class self-property READ.
    // For getters, inline the body with no instance prefix: the inlined
    // body's `this.field` references re-enter this visitor and resolve
    // via the same entry-point path below. `inlineResolvedMethodBody`
    // clears currentInlineContext when the prefix is undefined, so the
    // `!this.currentInlineContext` guard on this branch correctly fires
    // during the nested resolution.
    if (
      node.object.kind === ASTNodeKind.ThisExpression &&
      this.currentClassName &&
      this.entryPointClasses.has(this.currentClassName) &&
      !this.currentInlineContext &&
      !this.currentThisOverride
    ) {
      const resolved = resolveClassProperty(
        this,
        this.currentClassName,
        node.property,
      );
      if (resolved) {
        if (resolved.prop.isGetter) {
          const inlined = evaluateInlineGetter(
            this,
            resolved.prop,
            this.currentClassName,
            undefined,
          );
          if (inlined !== null) return inlined;
          // Recursion detected or missing body — fall through to the
          // phantom-slot read so downstream code has a variable to work
          // with, but surface the issue so it doesn't silently return
          // uninitialized data.
          this.warnAt(
            node,
            "EntryPointGetterUnsupported",
            `Getter "${this.currentClassName}.${node.property}" could not be inlined (likely recursive). The read returns an uninitialized slot — refactor to avoid recursion or use a method.`,
          );
        }
        return createVariable(
          this.entryPointPropName(node.property),
          resolved.prop.type,
        );
      }
    }

    if (node.object.kind === ASTNodeKind.Identifier) {
      const objectName = (node.object as IdentifierNode).name;
      const objectSymbol = this.symbolTable.lookup(objectName);
      const directSlot = tryReadPopulatedStructuralFieldSlot(
        this,
        identifierSlotName(this, objectName, objectSymbol),
        objectSymbol?.type,
        node.property,
      );
      if (directSlot) return directSlot;
      const instanceInfo = this.resolveInlineInstance(objectName);
      let mappedPropertyIsUntrackedStructuralHandle = false;
      if (instanceInfo) {
        const soaClass = resolveConcreteClassName(this, instanceInfo);
        if (!this.soaClasses.has(soaClass)) {
          const mapped = tryMapInlinePropertyWithConcreteFallback(
            this,
            instanceInfo,
            node.property,
          );
          const mappedKey = mapped ? operandTrackingKey(mapped) : undefined;
          if (mapped && !this.untrackedStructuralHandleVars.has(mappedKey ?? "")) {
            return mapped;
          }
          if (mappedKey && this.untrackedStructuralHandleVars.has(mappedKey)) {
            mappedPropertyIsUntrackedStructuralHandle = true;
          }
        }
      }
      if (
        // Only synthesise the per-field slot when the local actually has a
        // backing inline-instance mapping (i.e. visitVariableDeclaration's
        // structural-fix block emitted `${objectName}_${prop}` copies).
        // Without `instanceInfo` the slot was never written — falling through
        // to D-3 untracked-handle dispatch is the only way to read the value.
        instanceInfo &&
        !mappedPropertyIsUntrackedStructuralHandle &&
        objectSymbol?.type instanceof InterfaceTypeSymbol &&
        objectSymbol.type.properties.has(node.property)
      ) {
        const propTypeRaw = objectSymbol.type.properties.get(node.property);
        if (propTypeRaw) {
          const slotBase = identifierSlotName(this, objectName, objectSymbol);
          const propType =
            this.fieldTypeRegistry.getInterfacePropertyType(
              {
                typeMapper: this.typeMapper,
                classRegistry: this.classRegistry,
              },
              objectSymbol.type.name,
              node.property,
            ) ??
            (propTypeRaw.name
              ? (this.typeMapper.getAlias(propTypeRaw.name) ?? propTypeRaw)
              : propTypeRaw);
          return createVariable(`${slotBase}_${node.property}`, propType, {
            isLocal: true,
          });
        }
      }
      const registryStructuralField =
        this.fieldTypeRegistry.getStructuralFieldType(node.property);
      const structuralPropertyType =
        registryStructuralField !== undefined
          ? (inferInlineStructuralPropertyType(this, node.property) ??
            registryStructuralField)
          : undefined;
      const isAnonymousInlineRecord =
        objectSymbol?.type instanceof InterfaceTypeSymbol &&
        objectSymbol.type.name.startsWith("__anon_") &&
        !objectSymbol.type.name.startsWith("__anon_union_") &&
        isInlineHandleType(this, objectSymbol.type);
      if (
        // Same backing-slot requirement as the typed-interface branch above:
        // the `${objectName}_${prop}` slot is only written by the structural
        // field-copy block in visitVariableDeclaration when the source
        // resolves to an inline instance. Without `instanceInfo`, the slot
        // was never written and falling through to D-3 untracked-handle
        // dispatch is the only way to read a real value.
        instanceInfo &&
        !mappedPropertyIsUntrackedStructuralHandle &&
        structuralPropertyType &&
        registryStructuralField !== undefined &&
        objectSymbol &&
        !isAnonymousInlineRecord
      ) {
        const slotBase = identifierSlotName(this, objectName, objectSymbol);
        return createVariable(
          `${slotBase}_${node.property}`,
          structuralPropertyType,
        );
      }
    }

    // Static property access on inline classes: ClassName.staticField
    if (node.object.kind === ASTNodeKind.Identifier) {
      const objectName = (node.object as IdentifierNode).name;
      if (
        !this.symbolTable.lookup(objectName) && // not shadowed by a local
        resolveClassNode(this, objectName) &&
        !this.udonBehaviourClasses.has(objectName)
      ) {
        const mapped = this.mapStaticProperty(objectName, node.property);
        if (mapped) {
          return mapped;
        }
      }
    }

    if (node.object.kind === ASTNodeKind.Identifier) {
      const objectName = (node.object as IdentifierNode).name;
      const externSig = this.resolveStaticExtern(
        objectName,
        node.property,
        "getter",
      );
      if (externSig) {
        const returnType = resolveExternReturnType(externSig) ?? ObjectType;
        const result = this.newTemp(returnType);
        this.emit(new CallInstruction(result, externSig, []));
        return result;
      }
    }

    if (node.object.kind === ASTNodeKind.PropertyAccessExpression) {
      const access = node.object as PropertyAccessExpressionNode;
      const nestedProperty = `${access.property}_${node.property}`;
      if (
        access.object.kind === ASTNodeKind.ThisExpression &&
        this.currentInlineContext &&
        !this.currentThisOverride &&
        !this.currentInlineContext.instancePrefix.startsWith("__viface_")
      ) {
        const baseType = resolveClassProperty(
          this,
          this.currentInlineContext.className,
          access.property,
        )?.prop.type;
        const baseSlot = this.mapInlineProperty(
          this.currentInlineContext.className,
          this.currentInlineContext.instancePrefix,
          access.property,
        );
        const nestedType = resolveStructuralPropertyType(
          this,
          baseType,
          node.property,
        );
        if (nestedType || (baseSlot && access.property === "hanConfig")) {
          return createVariable(
            `${this.currentInlineContext.instancePrefix}_${access.property}_${node.property}`,
            nestedType ?? ObjectType,
          );
        }
        const directNestedSlot = tryReadPopulatedStructuralFieldSlot(
          this,
          `${this.currentInlineContext.instancePrefix}_${access.property}`,
          baseType,
          node.property,
        );
        if (directNestedSlot) return directNestedSlot;
        const nested = tryMapInlinePropertyWithConcreteFallback(
          this,
          {
            className: this.currentInlineContext.className,
            prefix: this.currentInlineContext.instancePrefix,
          },
          nestedProperty,
        );
        if (nested !== undefined) return nested;
      }
      if (access.object.kind === ASTNodeKind.Identifier) {
        const receiverName = (access.object as IdentifierNode).name;
        const receiverSymbol = this.symbolTable.lookup(receiverName);
        const receiverSlot = identifierSlotName(
          this,
          receiverName,
          receiverSymbol,
        );
        const baseType = resolveStructuralPropertyType(
          this,
          receiverSymbol?.type,
          access.property,
        );
        const directNestedSlot = tryReadPopulatedStructuralFieldSlot(
          this,
          `${receiverSlot}_${access.property}`,
          baseType,
          node.property,
        );
        if (directNestedSlot) return directNestedSlot;
        const receiverInfo = this.resolveInlineInstance(receiverName);
        if (receiverInfo) {
          const nested = tryMapInlinePropertyWithConcreteFallback(
            this,
            receiverInfo,
            nestedProperty,
          );
          if (nested !== undefined) return nested;
          const nestedType = resolveNestedStructuralPropertyType(
            this,
            receiverSymbol?.type,
            access.property,
            node.property,
          );
          if (nestedType && receiverInfo.prefix.startsWith("__viface_")) {
            return createVariable(
              `${receiverInfo.prefix}_${nestedProperty}`,
              nestedType,
            );
          }
        }
      }
      if (
        access.object.kind === ASTNodeKind.Identifier &&
        (access.object as IdentifierNode).name === "process" &&
        access.property === "env" &&
        node.property === "NODE_ENV"
      ) {
        return createConstant("production", PrimitiveTypes.string);
      }
    }

    const object = this.visitExpression(node.object);

    // Post-evaluation inline instance resolution for chained access.
    // Inside inlined methods this is typically a direct hit since
    // currentParamExportMap is empty; in caller context the helper
    // bridges raw ↔ export names via currentParamExportMap.
    // operandTrackingKey handles both Variable and Temporary operands.
    const instanceKey = operandTrackingKey(object);
    const instanceInfo = instanceKey
      ? this.resolveInlineInstance(instanceKey)
      : undefined;

    if (instanceInfo) {
      emitSoaHandleRestore(this, instanceInfo, object);

      const mapped = tryMapInlinePropertyWithConcreteFallback(
        this,
        instanceInfo,
        node.property,
      );
      if (mapped) return mapped;

      // Interface classId-based property dispatch: when the interface-level
      // mapInlineProperty fails (e.g. property not in interface metadata),
      // fall back to dispatching by classId to each concrete implementor.
      const classIds = this.interfaceClassIdMap.get(instanceInfo.className);
      if (
        classIds &&
        classIds.size > 0 &&
        isAllInlineInterface(this, instanceInfo.className)
      ) {
        let propType: TypeSymbol | undefined;
        for (const [className] of classIds) {
          const resolved = resolveClassProperty(this, className, node.property);
          if (resolved) {
            // For getters, `getterReturnType` is the authoritative return
            // shape — today it matches `type`, but using it keeps the
            // allocation correct if the two ever diverge (e.g. a future
            // refinement where `type` is generic/erased while
            // `getterReturnType` is concrete).
            propType = resolved.prop.isGetter
              ? (resolved.prop.getterReturnType ?? resolved.prop.type)
              : resolved.prop.type;
            break;
          }
        }
        if (propType) {
          const result = createVariable(
            `__iface_prop_${this.tempCounter++}`,
            propType,
            { isLocal: true },
          );
          const endLabel = this.newLabel("iface_prop_end");
          const classIdVar = createVariable(
            `${instanceInfo.prefix}__classId`,
            PrimitiveTypes.int32,
          );

          for (const [className, classId] of classIds) {
            const nextLabel = this.newLabel("iface_prop_next");
            const cond = this.newTemp(PrimitiveTypes.boolean);
            this.emit(
              new BinaryOpInstruction(
                cond,
                classIdVar,
                "==",
                createConstant(classId, PrimitiveTypes.int32),
              ),
            );
            this.emit(new ConditionalJumpInstruction(cond, nextLabel));

            const concreteGetter = tryInlineGetter(
              this,
              className,
              instanceInfo.prefix,
              node.property,
            );
            if (concreteGetter !== undefined) {
              this.emitCopyWithTracking(result, concreteGetter);
            } else {
              const concreteMapped = this.mapInlineProperty(
                className,
                instanceInfo.prefix,
                node.property,
              );
              if (concreteMapped) {
                this.emitCopyWithTracking(result, concreteMapped);
              } else {
                // Both paths declined: resolveClassProperty succeeded but
                // neither the getter-inline nor the variable-mapping path
                // could produce an operand. The only reachable cause is a
                // getter whose evaluation was skipped by
                // `inlineMethodStack` recursion detection — e.g. an
                // interface getter whose body accesses another instance of
                // the same interface, causing classId dispatch to
                // re-enter the same getter mid-inlining.  Previously this
                // threw "Internal error"; now the arm falls through to the
                // `endLabel` jump with the result variable left
                // uninitialized for this classId. Warn so the condition is
                // visible rather than silent.
                this.warnAt(
                  node,
                  "D3DispatchFallback",
                  `Interface classId dispatch could not produce an operand for getter "${className}.${node.property}" — likely recursion through interface dispatch. Arm for classId ${classId} is a no-op; the result is uninitialized when this arm fires at runtime.`,
                );
              }
            }

            this.emit(new UnconditionalJumpInstruction(endLabel));
            this.emit(new LabelInstruction(nextLabel));
          }
          this.emit(new LabelInstruction(endLabel));
          return result;
        }
      }
    }

    const inlineLocalObjectKey = operandTrackingKey(object);
    if (
      inlineLocalObjectKey &&
      this.currentInlineLocalPrefix &&
      inlineLocalObjectKey.startsWith(this.currentInlineLocalPrefix)
    ) {
      const siblingType =
        this.structuralFieldPrefixTypes
          .get(inlineLocalObjectKey)
          ?.get(node.property) ??
        this.fieldTypeRegistry.getStructuralFieldType(node.property) ??
        inferInlineStructuralPropertyType(this, node.property);
      if (siblingType) {
        return createVariable(
          `${inlineLocalObjectKey}_${node.property}`,
          siblingType,
          { isLocal: true },
        );
      }
    }
    const populatedStructuralObjectKey = operandTrackingKey(object);
    if (
      populatedStructuralObjectKey &&
      !this.untrackedStructuralHandleVars.has(populatedStructuralObjectKey)
    ) {
      const populatedType = this.structuralFieldPrefixTypes
        .get(populatedStructuralObjectKey)
        ?.get(node.property);
      if (populatedType) {
        return createVariable(
          `${populatedStructuralObjectKey}_${node.property}`,
          populatedType,
          { isLocal: true },
        );
      }
    }

    if (node.object.kind === ASTNodeKind.PropertyAccessExpression) {
      const access = node.object as PropertyAccessExpressionNode;
      if (access.object.kind === ASTNodeKind.Identifier) {
        const receiverName = (access.object as IdentifierNode).name;
        const receiverSymbol = this.symbolTable.lookup(receiverName);
        const baseType = resolveStructuralPropertyType(
          this,
          receiverSymbol?.type,
          access.property,
        );
        const baseInterface = resolveStructuralInterface(this, baseType);
        if (
          baseInterface?.properties.has(node.property) &&
          !this.udonBehaviourClasses.has(baseInterface.name)
        ) {
          const propType =
            resolveStructuralPropertyType(this, baseInterface, node.property) ??
            ObjectType;
          const dispatched = tryEmitStructuralInterfacePropertyDispatch(
            this,
            object,
            baseInterface,
            node.property,
            propType,
          );
          if (dispatched) return dispatched;
          const missResult = this.newTemp(propType);
          this.emit(
            new AssignmentInstruction(
              missResult,
              createSoaSentinelValue(this, propType),
            ),
          );
          const logExtern = this.requireExternSignature(
            "Debug",
            "LogError",
            "method",
            ["object"],
            "void",
          );
          this.emit(
            new CallInstruction(undefined, logExtern, [
              createConstant(
                `[udon-assembly-ts] structural dispatch miss: ${node.property} on nested structural handle`,
                PrimitiveTypes.string,
              ),
            ]),
          );
          return missResult;
        }
      }
    }

    // Handle-based dispatch for variables/temporaries of known concrete inline
    // types. Fires when the tracked path above did not return a result — either
    // because the operand has no tracking entry, or because both
    // tryMapInlinePropertyWithConcreteFallback and the classId dispatch failed.
    // This acts as the final fallback before a raw PropertyGetInstruction.
    // Limited to ≤100 instances per class to avoid excessive code.
    // Covers both Variable and Temporary operands (e.g. tiles[i].code).
    if (
      object.kind === TACOperandKind.Variable ||
      object.kind === TACOperandKind.Temporary
    ) {
      const untrackedType = this.getOperandType(object);
      const untrackedTypeName = untrackedType.name;
      if (
        untrackedTypeName &&
        !this.udonBehaviourClasses.has(untrackedTypeName)
      ) {
        const astBaseTypeForDispatch =
          resolveDeclaredTypeFromNode(this, node.object) ??
          resolveTypeFromNode(this, node.object);
        const astTypeNameForDispatch = astBaseTypeForDispatch?.name;
        const directSoaTypeName = this.soaClasses.has(untrackedTypeName)
          ? untrackedTypeName
          : astTypeNameForDispatch &&
              !this.udonBehaviourClasses.has(astTypeNameForDispatch) &&
              this.soaClasses.has(astTypeNameForDispatch)
            ? astTypeNameForDispatch
            : undefined;
        const directSoaResolved = resolveClassProperty(
          this,
          directSoaTypeName ?? untrackedTypeName,
          node.property,
        );
        const objectKey = operandTrackingKey(object);
        const trackedObjectInfo = objectKey
          ? this.inlineInstanceMap.get(objectKey)
          : undefined;
        const directSoaAllowed =
          trackedObjectInfo !== undefined &&
          this.soaInstancePrefixes.has(trackedObjectInfo.prefix);
        if (
          directSoaTypeName &&
          directSoaAllowed &&
          this.soaFieldLists.has(directSoaTypeName)
        ) {
          const directSoaFieldName = directSoaResolved?.prop.isGetter
            ? resolveSimpleGetterBackingField(directSoaResolved.prop)
            : node.property;
          const fieldList = this.soaFieldLists
            .get(directSoaTypeName)
            ?.get(directSoaFieldName ?? node.property);
          if (fieldList) {
            const fieldType =
              (directSoaResolved?.prop.isGetter
                ? (directSoaResolved.prop.getterReturnType ??
                  directSoaResolved.prop.type)
                : directSoaResolved?.prop.type) ??
              this.soaFieldTypes
                .get(directSoaTypeName)
                ?.get(directSoaFieldName ?? node.property) ??
              ObjectType;
            const hdlVar = normalizeOperandToInt32(this, object);
            const indexVar = emitSoaHandleToIndex(
              this,
              hdlVar,
              directSoaTypeName,
            );
            const token = this.newTemp(ExternTypes.dataToken);
            emitBoundedDataListGetItem(
              this,
              fieldList,
              indexVar,
              token,
              createSoaSentinelValue(this, fieldType),
              true,
              directSoaTypeName,
            );
            return this.unwrapDataToken(token, fieldType);
          }
        }

        const dispInstances: Array<
          [number, { prefix: string; className: string }]
        > = [];
        // Also match concrete implementors when untrackedTypeName is an
        // interface name (e.g. IYaku). classRegistry is authoritative because
        // it is built from class declarations before codegen starts.
        // Cache per-type to avoid repeated O(N) lookups across property accesses
        // on the same untracked interface-typed variable.
        if (!this.implementorNamesCache.has(untrackedTypeName)) {
          this.implementorNamesCache.set(
            untrackedTypeName,
            this.classRegistry
              ? new Set(
                  this.classRegistry
                    .getImplementorsOfInterface(untrackedTypeName)
                    .map((i) => i.name),
                )
              : null,
          );
        }
        const implementorNames =
          this.implementorNamesCache.get(untrackedTypeName) ?? null;
        // Structural anon-union return types (e.g. `type Result = Win | Loss`
        // resolved to `__anon_union_N`) have no classRegistry entry and no
        // explicit implementors. Admit concrete classes (Win, Loss, ...)
        // whose declared InterfaceTypeSymbol carries the specific property
        // being accessed with a type-compatible declaration. Matching on the
        // accessed property rather than the full merged superset keeps every
        // union branch's instances in the dispatch for that property —
        // otherwise a branch carrying only a subset of the merged union's
        // fields (e.g. Loss lacking Win's `value`/`list`) would silently fall
        // off the end of the dispatch and return the Udon zero default in
        // place of its real slot when the runtime handle points at that
        // branch's instance.
        const untrackedAlias = this.typeMapper.getAlias(untrackedTypeName);
        const isInterfaceHandlePropertyDispatch =
          untrackedAlias instanceof InterfaceTypeSymbol &&
          untrackedAlias.properties.has(node.property);
        const untrackedAnonUnion = untrackedTypeName.startsWith(
          "__anon_union_",
        )
          ? untrackedType instanceof InterfaceTypeSymbol &&
            untrackedType.properties.size > 0
            ? untrackedType
            : untrackedAlias instanceof InterfaceTypeSymbol &&
                untrackedAlias.properties.size > 0
              ? untrackedAlias
              : this.typeMapper.getAlias(untrackedTypeName)
          : undefined;
        const anonUnionIface =
          untrackedAnonUnion instanceof InterfaceTypeSymbol &&
          untrackedAnonUnion.properties.size > 0
            ? untrackedAnonUnion
            : null;
        // True when at least one dispInstance was contributed while operating in
        // structural-union dispatch mode (anonUnionIface !== null). Instances
        // may match via className === untrackedTypeName (when the object-literal
        // was created directly as `__anon_union_N`) OR via
        // hasCompatibleUnionProperty (when a concrete variant class like
        // `StandardWin` is matched against the union interface). Both need the
        // wider dispatch limit (512) and the erased miss-path diagnostic.
        // Note: mutually exclusive with usedErasedFallback because erased
        // fallbacks run only when dispInstances is empty after the main loop.
        let usedAnonUnionIface = false;
        for (const [instId, info] of this.allInlineInstances) {
          if (
            info.className === untrackedTypeName ||
            implementorNames?.has(info.className) ||
            isSubclassOf(this, info.className, untrackedTypeName)
          ) {
            dispInstances.push([instId, info]);
            if (anonUnionIface !== null) {
              // untrackedTypeName is __anon_union_N — these are structural-union
              // instances and need the same wider limit as the union iface path.
              usedAnonUnionIface = true;
            }
          } else if (
            anonUnionIface !== null &&
            hasCompatibleUnionProperty(
              this,
              info.className,
              anonUnionIface,
              node.property,
            )
          ) {
            dispInstances.push([instId, info]);
            usedAnonUnionIface = true;
          }
        }
        // Track whether dispInstances were populated by a fallback heuristic
        // (AST type or property-based). When true, a miss path must emit a
        // PropertyGetInstruction instead of returning a zeroed heap default,
        // because the runtime value may not be an inline handle at all.
        let usedErasedFallback = false;
        // AST type fallback: when operand type is erased (ObjectType,
        // CollectionTypeSymbol, etc.) and no instances matched, try resolving
        // the base type from the AST and retry with that name.
        if (dispInstances.length === 0) {
          const astBaseType = resolveTypeFromNode(this, node.object);
          const astTypeName = astBaseType?.name;
          if (astTypeName && astTypeName !== untrackedTypeName) {
            if (!this.implementorNamesCache.has(astTypeName)) {
              this.implementorNamesCache.set(
                astTypeName,
                this.classRegistry
                  ? new Set(
                      this.classRegistry
                        .getImplementorsOfInterface(astTypeName)
                        .map((i) => i.name),
                    )
                  : null,
              );
            }
            const astImplementorNames =
              this.implementorNamesCache.get(astTypeName) ?? null;
            for (const [instId, info] of this.allInlineInstances) {
              if (
                info.className === astTypeName ||
                astImplementorNames?.has(info.className) ||
                isSubclassOf(this, info.className, astTypeName)
              ) {
                dispInstances.push([instId, info]);
              }
            }
            if (dispInstances.length > 0) usedErasedFallback = true;
          }
        }
        // Structural-subset fallback: a value can be declared as a smaller
        // structural shape than the object literal that actually flows through
        // it, e.g. `{ estimate: { maxHan } }` while the runtime handle points
        // at `{ estimate: { minHan, maxHan } }`. Dispatch to concrete inline
        // instances whose property type contains the requested structural
        // shape instead of falling through to a raw PropertyGetInstruction.
        if (dispInstances.length === 0) {
          const structuralIface =
            untrackedType instanceof InterfaceTypeSymbol &&
            untrackedType.properties.size > 0
              ? untrackedType
              : untrackedAlias instanceof InterfaceTypeSymbol &&
                  untrackedAlias.properties.size > 0
                ? untrackedAlias
                : null;
          if (structuralIface?.properties.has(node.property)) {
            for (const [instId, info] of this.allInlineInstances) {
              if (
                hasAssignableStructuralProperty(
                  this,
                  info.className,
                  structuralIface,
                  node.property,
                )
              ) {
                dispInstances.push([instId, info]);
              }
            }
            if (dispInstances.length > 0) usedErasedFallback = true;
          }
        }
        // Property-based fallback: when the operand type is erased and no
        // instances matched by type name, scan inline instances for classes
        // that expose the accessed property. Fires for both ObjectType
        // (name "object") and ExternTypes.dataDictionary (name "DataDictionary",
        // because TypeMapper maps TS "object" to dataDictionary).
        if (
          dispInstances.length === 0 &&
          (untrackedTypeName === "object" ||
            untrackedTypeName === "DataDictionary" ||
            (untrackedType.udonType === UdonType.Object &&
              this.dispatchLimitResolver.isLargeErasedFallbackProperty(
                node.property,
              )))
        ) {
          const candidateClasses = new Set<string>();
          for (const [, info] of this.allInlineInstances) {
            if (candidateClasses.has(info.className)) continue;
            // Use resolveClassProperty (class-definition lookup) instead of
            // mapInlineProperty (heap-variable lookup) so the check does not
            // depend on a specific instance's prefix.
            const alias = this.typeMapper.getAlias(info.className);
            if (
              resolveClassProperty(this, info.className, node.property) ||
              (alias instanceof InterfaceTypeSymbol &&
                alias.properties.has(node.property))
            ) {
              candidateClasses.add(info.className);
            }
          }
          if (candidateClasses.size === 1) {
            // Exactly one class matches — use it directly.
            for (const [instId, info] of this.allInlineInstances) {
              if (candidateClasses.has(info.className)) {
                dispInstances.push([instId, info]);
              }
            }
            if (dispInstances.length > 0) usedErasedFallback = true;
          } else if (candidateClasses.size > 1) {
            // Multiple classes share this property name. Try to narrow using
            // the AST type of the object node (e.g. the declared element type
            // of a for-of loop variable, or an interface implementor).
            const astType = resolveTypeFromNode(this, node.object);
            const astName =
              astType?.name ??
              inferIdentifierInitialPropertyClassName(this, node.object);
            let narrowedClass: string | undefined;
            // Implementors of the declared interface that appear in
            // candidateClasses.  Populated only when astName is an interface;
            // hoisted here so the else-if branch below can reference it.
            let matchedImpls: string[] = [];
            let structurallyNarrowedClasses: string[] = [];
            if (astName) {
              if (
                astType instanceof InterfaceTypeSymbol &&
                astName.startsWith("__anon_") &&
                astType.properties.has(node.property)
              ) {
                structurallyNarrowedClasses = [...candidateClasses].filter(
                  (candidate) =>
                    candidate.startsWith("__anon_") &&
                    !candidate.startsWith("__anon_union_") &&
                    hasAssignableStructuralProperty(
                      this,
                      candidate,
                      astType,
                      node.property,
                    ),
                );
              }
              if (structurallyNarrowedClasses.length > 0) {
                // Keep the structurally richer anonymous records that can
                // satisfy the receiver's smaller structural shape. This avoids
                // falling back to unrelated named classes that merely share a
                // property name (for example YakuHanConfig.type).
              } else if (candidateClasses.has(astName)) {
                narrowedClass = astName;
              } else {
                // AST type may be an interface — collect ALL implementors
                // that appear in candidateClasses so we can prefer the
                // semantically correct subset over the full property-match set.
                const implNames = this.classRegistry
                  ? this.classRegistry
                      .getImplementorsOfInterface(astName)
                      .map((i) => i.name)
                  : [];
                matchedImpls = implNames.filter((impl) =>
                  candidateClasses.has(impl),
                );
                if (matchedImpls.length === 1) {
                  narrowedClass = matchedImpls[0];
                }
                // matchedImpls.length > 1 → narrowedClass stays undefined;
                // the else-if branch dispatches exactly the matched set.
                // matchedImpls.length === 0 → falls to the final else branch.
              }
            }
            if (structurallyNarrowedClasses.length > 0) {
              const narrowedSet = new Set(structurallyNarrowedClasses);
              for (const [instId, info] of this.allInlineInstances) {
                if (narrowedSet.has(info.className)) {
                  dispInstances.push([instId, info]);
                }
              }
              if (dispInstances.length > 0) usedErasedFallback = true;
            } else if (narrowedClass) {
              for (const [instId, info] of this.allInlineInstances) {
                if (info.className === narrowedClass) {
                  dispInstances.push([instId, info]);
                }
              }
              if (dispInstances.length > 0) usedErasedFallback = true;
            } else if (matchedImpls.length > 1) {
              // The declared interface has multiple implementors in
              // candidateClasses.  Restrict dispatch to exactly those
              // implementors rather than the full candidateClasses set
              // (which may include unrelated classes that share only the
              // property name, not the interface).
              const matchedImplSet = new Set(matchedImpls);
              for (const [instId, info] of this.allInlineInstances) {
                if (matchedImplSet.has(info.className)) {
                  dispInstances.push([instId, info]);
                }
              }
              if (dispInstances.length > 0) usedErasedFallback = true;
            } else {
              // Last-resort narrowing: if the TypeChecker sees the receiver as a
              // heterogeneous union, its individual member names (e.g. "Meld" and
              // "__anon_isOpen:boolean|tiles:Tile[]|type:string") may intersect with
              // candidateClasses (as a subset, including full equality).  Classes
              // that merely share the property name but are not union members (e.g.
              // "Hand" when the param type is `Meld | AnonStruct`) are excluded.
              let unionNarrowed = false;
              if (this.checkerContext && this.checkerTypeResolver) {
                const unionNames =
                  this.checkerTypeResolver.resolveUnionMemberNamesFromAstNode(
                    node.object,
                    this.checkerContext,
                  );
                if (unionNames) {
                  const memberSet = new Set(unionNames);
                  const narrowedCandidates = [...candidateClasses].filter((c) =>
                    memberSet.has(c),
                  );
                  if (narrowedCandidates.length > 0) {
                    // All dispatched classes are confirmed union members — the
                    // dispatch is semantically correct whether or not we narrowed
                    // below the full candidateClasses set.
                    unionNarrowed = true;
                    const narrowedSet = new Set(narrowedCandidates);
                    for (const [instId, info] of this.allInlineInstances) {
                      if (narrowedSet.has(info.className)) {
                        dispInstances.push([instId, info]);
                      }
                    }
                    if (dispInstances.length > 0) usedErasedFallback = true;
                  }
                }
              }
              if (!unionNarrowed) {
                // Narrowing failed entirely — include instances from ALL
                // candidate classes so the dispatch table handles any
                // concrete class at runtime.  Log at transpile time so
                // developers can track mixed-class collections.
                this.warnAt(
                  node,
                  "D3DispatchFallback",
                  `D3 dispatch narrowing failed for property "${node.property}" — ${candidateClasses.size} candidate classes (${[...candidateClasses].join(", ")}), dispatching all candidates.`,
                );
                for (const [instId, info] of this.allInlineInstances) {
                  if (candidateClasses.has(info.className)) {
                    dispInstances.push([instId, info]);
                  }
                }
                if (dispInstances.length > 0) usedErasedFallback = true;
              }
            }
          }
        }
        const dispatchLimit = this.dispatchLimitResolver.getLimit({
          property: node.property,
          usedErasedFallback,
          isStructuralUnionDispatch:
            usedAnonUnionIface || isInterfaceHandlePropertyDispatch,
        });
        if (dispInstances.length > 1) {
          const soaClassName = dispInstances[0][1].className;
          if (
            this.soaClasses.has(soaClassName) &&
            dispInstances.every(([, info]) => info.className === soaClassName)
          ) {
            dispInstances.splice(1);
          }
        }
        if (
          (usedErasedFallback || usedAnonUnionIface) &&
          dispInstances.length > dispatchLimit
        ) {
          this.warnAt(
            node,
            "D3DispatchFallback",
            `D3 dispatch for property "${node.property}" has ${dispInstances.length} combined candidate instances (limit: ${dispatchLimit}) — dispatch block is skipped. The safety-net else-if branch will emit Debug.LogError + zero-init result to avoid an invalid PropertyGetInstruction EXTERN.`,
          );
        }
        if (dispInstances.length > 0 && dispInstances.length <= dispatchLimit) {
          let untrackedPropType: TypeSymbol | undefined;
          let propertyIsGetter = false;
          for (const [, info] of dispInstances) {
            const probeResolved = resolveClassProperty(
              this,
              info.className,
              node.property,
            );
            if (probeResolved?.prop.isGetter) {
              untrackedPropType =
                probeResolved.prop.getterReturnType ?? probeResolved.prop.type;
              propertyIsGetter = true;
              break;
            }
            const pv =
              this.mapInlineProperty(
                info.className,
                info.prefix,
                node.property,
              ) ??
              tryMapAliasInlineProperty(
                this,
                info.className,
                info.prefix,
                node.property,
              ) ??
              tryMapAnonymousUnionInlineProperty(
                this,
                info.className,
                info.prefix,
                node.property,
                anonUnionIface,
                untrackedPropType,
              );
            if (pv) {
              const pvType = this.getOperandType(pv);
              untrackedPropType ??= pvType;
              if (pvType !== ObjectType) {
                untrackedPropType = pvType;
                break;
              }
            }
          }
          if (untrackedPropType === ObjectType) {
            const structuralFieldType =
              this.fieldTypeRegistry.getStructuralFieldType(node.property);
            const inferredStructuralType =
              structuralFieldType !== undefined
                ? (inferInlineStructuralPropertyType(this, node.property) ??
                  structuralFieldType)
                : undefined;
            if (inferredStructuralType) {
              untrackedPropType = inferredStructuralType;
            }
          }
          // When the multi-class fallback path (D3DispatchFallback) populated
          // dispInstances from several candidate classes, warn if their property
          // types diverge: dispResult is typed from the first resolved class, so
          // emitCopyWithTracking for another class's arm writes a mismatched type
          // into the same heap slot.
          if (untrackedPropType && dispInstances.length > 1) {
            // dispInstances.length > 1 guarantees [0] exists (no optional chaining needed).
            const firstClass = dispInstances[0][1].className;
            const checkedClasses = new Set<string>([firstClass]);
            for (const [, info] of dispInstances) {
              if (checkedClasses.has(info.className)) continue;
              checkedClasses.add(info.className);
              const probe = resolveClassProperty(
                this,
                info.className,
                node.property,
              );
              const mappedProbe =
                this.mapInlineProperty(
                  info.className,
                  info.prefix,
                  node.property,
                ) ??
                tryMapAliasInlineProperty(
                  this,
                  info.className,
                  info.prefix,
                  node.property,
                ) ??
                tryMapAnonymousUnionInlineProperty(
                  this,
                  info.className,
                  info.prefix,
                  node.property,
                  anonUnionIface,
                  untrackedPropType,
                );
              const probeType = probe
                ? (probe.prop.getterReturnType ?? probe.prop.type)
                : mappedProbe
                  ? this.getOperandType(mappedProbe)
                  : undefined;
              if (probeType && probeType.name !== untrackedPropType.name) {
                this.warnAt(
                  node,
                  "D3DispatchFallback",
                  `D3 dispatch: property "${node.property}" type diverges across candidate classes — dispResult typed "${untrackedPropType.name}" but "${info.className}" has "${probeType.name}". Heap slot mismatch possible.`,
                );
                break;
              }
            }
          }
          if (untrackedPropType) {
            // SoA fast path: when ALL candidate instances belong to a single
            // SoA class, read the field from the per-field DataList at the
            // handle index. No per-instance branching needed.
            //
            // Skipped for getters: they intentionally have no soaFieldLists
            // entry (filtered out of collectAllInstanceFields). Per-arm
            // tryInlineGetter handles them correctly in the dispatch below;
            // entering the fast-path here would emit a misleading
            // SoAFieldListMissing warning.
            const soaClassName = dispInstances[0][1].className;
            const allSameClass = dispInstances.every(
              ([, i]) => i.className === soaClassName,
            );
            const allRuntimeSoA = dispInstances.every(([, i]) =>
              this.soaInstancePrefixes.has(i.prefix),
            );
            if (
              !propertyIsGetter &&
              allSameClass &&
              allRuntimeSoA &&
              this.soaClasses.has(soaClassName) &&
              this.soaFieldLists.has(soaClassName)
            ) {
              const fieldLists = this.soaFieldLists.get(soaClassName);
              const fieldList = fieldLists?.get(node.property);
              if (fieldList) {
                const hdlVar = normalizeOperandToInt32(this, object);
                const indexVar = emitSoaHandleToIndex(
                  this,
                  hdlVar,
                  soaClassName,
                );
                const token = this.newTemp(ExternTypes.dataToken);
                emitBoundedDataListGetItem(
                  this,
                  fieldList,
                  indexVar,
                  token,
                  createSoaSentinelValue(this, untrackedPropType),
                  true,
                  soaClassName,
                );
                const unwrapped = this.unwrapDataToken(token, untrackedPropType);
                const dispResult = createVariable(
                  `__uninst_prop_${this.tempCounter++}`,
                  untrackedPropType,
                  { isLocal: true },
                );
                this.emitCopyWithTracking(dispResult, unwrapped);
                emitSoaNestedStructuralFieldCopies(
                  this,
                  dispResult.name,
                  soaClassName,
                  node.property,
                  indexVar,
                );
                return dispResult;
              }
              // SoA class property not in soaFieldLists — the fallthrough
              // to static-handle dispatch below will always miss because
              // SoA handles are dynamic counters, not static instanceIds.
              this.warnAt(
                node,
                "SoAFieldListMissing",
                `SoA class "${soaClassName}" has no DataList for property "${node.property}". D3 dispatch will fall through to static-handle comparison which cannot match dynamic SoA handles.`,
              );
            }

            // Use the concrete inline field type for the dispatch result.
            // The miss path no longer emits a PropertyGetInstruction (it
            // uses Debug.LogError instead), so there is no need to widen
            // to ObjectType for heap-slot compatibility.
            const dispResult = createVariable(
              `__uninst_prop_${this.tempCounter++}`,
              untrackedPropType,
              { isLocal: true },
            );
            const shouldCopyDispatchStructuralFields = !(
              usedErasedFallback || usedAnonUnionIface
            );
            this.emit(
              new AssignmentInstruction(
                dispResult,
                createSoaSentinelValue(this, untrackedPropType),
              ),
            );
            const hdlVar = normalizeOperandToInt32(this, object);
            const dispEnd = this.newLabel("uninst_prop_end");
            let copiedDispatchStructuralFields = false;
            for (const [instId, info] of dispInstances) {
              const dispNext = this.newLabel("uninst_prop_next");
              const dispCond = this.newTemp(PrimitiveTypes.boolean);
              let nonZeroHandleCond: TACOperand | undefined;
              const isRuntimeSoAInstance = this.soaInstancePrefixes.has(
                info.prefix,
              );
              if (isRuntimeSoAInstance && this.soaClasses.has(info.className)) {
                const offset = this.soaClassOffsets.get(info.className);
                if (offset === undefined) {
                  this.emit(
                    new BinaryOpInstruction(
                      dispCond,
                      hdlVar,
                      "==",
                      createVariable(
                        `${info.prefix}__handle`,
                        PrimitiveTypes.int32,
                      ),
                    ),
                  );
                } else {
                  const lowerCond = this.newTemp(PrimitiveTypes.boolean);
                  const upperCond = this.newTemp(PrimitiveTypes.boolean);
                  const rangeEnd = this.newLabel("uninst_prop_range_end");
                  this.emit(
                    new AssignmentInstruction(
                      dispCond,
                      createConstant(false, PrimitiveTypes.boolean),
                    ),
                  );
                  this.emit(
                    new BinaryOpInstruction(
                      lowerCond,
                      hdlVar,
                      ">=",
                      createConstant(offset + 1, PrimitiveTypes.int32),
                    ),
                  );
                  this.emit(
                    new ConditionalJumpInstruction(lowerCond, rangeEnd),
                  );
                  this.emit(
                    new BinaryOpInstruction(
                      upperCond,
                      hdlVar,
                      "<",
                      createConstant(
                        offset + SOA_PARTITION_SIZE,
                        PrimitiveTypes.int32,
                      ),
                    ),
                  );
                  this.emit(
                    new ConditionalJumpInstruction(upperCond, rangeEnd),
                  );
                  this.emit(
                    new AssignmentInstruction(
                      dispCond,
                      createConstant(true, PrimitiveTypes.boolean),
                    ),
                  );
                  this.emit(new LabelInstruction(rangeEnd));
                }
              } else {
                const instanceHandle = createVariable(
                  `${info.prefix}__handle`,
                  PrimitiveTypes.int32,
                );
                this.emit(
                  new BinaryOpInstruction(
                    dispCond,
                    hdlVar,
                    "==",
                    instanceHandle,
                  ),
                );
                nonZeroHandleCond = this.newTemp(PrimitiveTypes.boolean);
                this.emit(
                  new BinaryOpInstruction(
                    nonZeroHandleCond,
                    instanceHandle,
                    "!=",
                    createConstant(0, PrimitiveTypes.int32),
                  ),
                );
              }
              this.emit(
                // Jump to dispNext when handle does NOT match (JUMP_IF_FALSE semantics)
                new ConditionalJumpInstruction(dispCond, dispNext),
              );
              if (nonZeroHandleCond) {
                this.emit(
                  new ConditionalJumpInstruction(nonZeroHandleCond, dispNext),
                );
              }
              if (isRuntimeSoAInstance && this.soaClasses.has(info.className)) {
                this.emit(
                  new CopyInstruction(
                    createVariable(
                      `${info.prefix}__handle`,
                      PrimitiveTypes.int32,
                    ),
                    hdlVar,
                  ),
                );
              }
              const armGetter = tryInlineGetter(
                this,
                info.className,
                info.prefix,
                node.property,
              );
              if (armGetter !== undefined) {
                this.emitCopyWithTracking(dispResult, armGetter);
                const dispKey = operandTrackingKey(dispResult);
                if (dispKey && shouldCopyDispatchStructuralFields) {
                  emitStructuralFieldCopies(
                    this,
                    dispKey,
                    untrackedPropType,
                    armGetter,
                    { isLocal: true },
                  );
                }
              } else {
                const pv =
                  this.mapInlineProperty(
                    info.className,
                    info.prefix,
                    node.property,
                  ) ??
                  tryMapAliasInlineProperty(
                    this,
                    info.className,
                    info.prefix,
                    node.property,
                  ) ??
                  tryMapAnonymousUnionInlineProperty(
                    this,
                    info.className,
                    info.prefix,
                    node.property,
                    anonUnionIface,
                    untrackedPropType,
                );
                if (pv) {
                  const fieldList =
                    isRuntimeSoAInstance && this.soaClasses.has(info.className)
                      ? this.soaFieldLists
                          .get(info.className)
                          ?.get(node.property)
                      : undefined;
                  if (fieldList) {
                    const indexVar = emitSoaHandleToIndex(
                      this,
                      hdlVar,
                      info.className,
                    );
                    const token = this.newTemp(ExternTypes.dataToken);
                    emitBoundedDataListGetItem(
                      this,
                      fieldList,
                      indexVar,
                      token,
                      createSoaSentinelValue(this, untrackedPropType),
                      true,
                      info.className,
                    );
                    const unwrapped = this.unwrapDataToken(
                      token,
                      untrackedPropType,
                    );
                    this.emitCopyWithTracking(dispResult, unwrapped);
                    const dispKey = operandTrackingKey(dispResult);
                    if (dispKey) {
                      copiedDispatchStructuralFields =
                        emitSoaNestedStructuralFieldCopies(
                          this,
                          dispKey,
                          info.className,
                          node.property,
                          indexVar,
                        ) || copiedDispatchStructuralFields;
                    }
                    if (dispKey && shouldCopyDispatchStructuralFields) {
                      emitStructuralFieldCopies(
                        this,
                        dispKey,
                        untrackedPropType,
                        unwrapped,
                        { isLocal: true },
                      );
                    }
                  } else {
                    this.emitCopyWithTracking(dispResult, pv);
                    const dispKey = operandTrackingKey(dispResult);
                    const pvKey = operandTrackingKey(pv);
                    if (dispKey && pvKey) {
                      copiedDispatchStructuralFields =
                        emitKnownStructuralFieldCopies(this, pvKey, dispKey) ||
                        copiedDispatchStructuralFields;
                    }
                    if (dispKey && shouldCopyDispatchStructuralFields) {
                      emitStructuralFieldCopies(
                        this,
                        dispKey,
                        untrackedPropType,
                        pv,
                        { isLocal: true },
                      );
                      copiedDispatchStructuralFields =
                        this.structuralFieldPrefixes.has(dispKey) ||
                        this.structuralFieldPrefixTypes.has(dispKey) ||
                        copiedDispatchStructuralFields;
                    }
                  }
                } else if (propertyIsGetter) {
                  // Symmetric with the interface classId dispatch arm at
                  // ~line 2045: when both paths decline for a getter the
                  // only reachable cause is inline-stack recursion. Warn so
                  // the condition is visible instead of silently skipping.
                  this.warnAt(
                    node,
                    "D3DispatchFallback",
                    `D3 dispatch arm for instance ${instId} could not produce an operand for getter "${info.className}.${node.property}" — likely recursion through dispatch. Arm is a no-op; the result is uninitialized when this arm fires at runtime.`,
                  );
                }
                // If pv is undefined AND the property is not a getter, it
                // means mapInlineProperty failed for this instance. This
                // can occur in the multi-class fallback (D3DispatchFallback)
                // where dispInstances may contain instances from several
                // candidate classes; an arm from one class may not find its
                // property mapping in another class's prefix layout.
                else {
                  this.warnAt(
                    node,
                    "D3DispatchFallback",
                    `D3 dispatch arm for instance ${instId} (class "${info.className}") could not map property "${node.property}" — arm emits no copy; dispResult retains zero-init default.`,
                  );
                }
              }
              this.emit(new UnconditionalJumpInstruction(dispEnd));
              this.emit(new LabelInstruction(dispNext));
            }
            // Miss path: if no handle matched in the dispatch table.
            if (usedErasedFallback || usedAnonUnionIface) {
              // Do NOT emit PropertyGetInstruction here. The erased owner
              // type produces invalid EXTERN signatures (e.g.
              // DataDictionary.__get_isOpen__SystemObject, or
              // SystemObject.__get_isWin__SystemBoolean for structural unions)
              // that the Udon VM rejects at load time. The miss path is
              // unreachable when all instances of the target class are tracked
              // via allInlineInstances. Emit a diagnostic log so that reaching
              // this path at runtime (which would indicate a transpiler bug)
              // is visible in the VRChat console.
              const logExtern = this.requireExternSignature(
                "Debug",
                "LogError",
                "method",
                ["object"],
                "void",
              );
              const errMsg = createConstant(
                `[udon-assembly-ts] D3 dispatch miss: ${node.property} on untracked instance`,
                PrimitiveTypes.string,
              );
              this.emit(new CallInstruction(undefined, logExtern, [errMsg]));
              // dispResult retains its Udon heap zero-initialised default
              // (null for references, 0 for int32, false for bool).
              // No explicit COPY needed — emitting one with a null literal
              // would risk a type mismatch for value types.
            }
            // For non-erased D3 dispatch the miss is unreachable: every object
            // of the matched type was constructed via a tracked constructor,
            // so its runtime handle always matches one branch above.
            this.emit(new LabelInstruction(dispEnd));
            const dispKey = operandTrackingKey(dispResult);
            const structuralResultType =
              resolveStructuralInterface(this, untrackedPropType) !== undefined
                ? untrackedPropType
                : (inferInlineStructuralPropertyType(this, node.property) ??
                  this.fieldTypeRegistry.getStructuralFieldType(node.property));
            if (
              dispKey &&
              structuralResultType &&
              !copiedDispatchStructuralFields &&
              resolveStructuralInterface(this, structuralResultType)
            ) {
              markUntrackedStructuralHandlePrefixes(
                this,
                dispKey,
                structuralResultType,
              );
            }
            return dispResult;
          }
        } else if (
          dispInstances.length > dispatchLimit &&
          (usedErasedFallback ||
            usedAnonUnionIface ||
            isInterfaceHandlePropertyDispatch)
        ) {
          // Dispatch limit exceeded for a structural-union or erased-fallback
          // path. We cannot emit the full dispatch table, but we MUST NOT fall
          // through to PropertyGetInstruction: on an untracked structural-union
          // handle that is typed as SystemObject, it generates an invalid EXTERN
          // (e.g. SystemObject.__get_isWin__SystemBoolean) that Unity rejects
          // at runtime with NotSupportedException.
          //
          // Emit a zero-init result and a Debug.LogError miss diagnostic.
          // Reaching this at runtime indicates a transpiler bug (the limit
          // should be tuned via DispatchLimitResolver so the table fits).
          let missType: TypeSymbol | undefined;
          for (const [, info] of dispInstances) {
            const probeResolved = resolveClassProperty(
              this,
              info.className,
              node.property,
            );
            if (probeResolved?.prop.isGetter) {
              missType =
                probeResolved.prop.getterReturnType ?? probeResolved.prop.type;
              break;
            }
            const pv =
              this.mapInlineProperty(
                info.className,
                info.prefix,
                node.property,
              ) ??
              tryMapAliasInlineProperty(
                this,
                info.className,
                info.prefix,
                node.property,
              ) ??
              tryMapAnonymousUnionInlineProperty(
                this,
                info.className,
                info.prefix,
                node.property,
                anonUnionIface,
                missType,
              );
            if (pv) {
              missType = this.getOperandType(pv);
              break;
            }
          }
          const missResult = createVariable(
            `__uninst_prop_${this.tempCounter++}`,
            missType ?? ObjectType,
            { isLocal: true },
          );
          this.emit(
            new AssignmentInstruction(
              missResult,
              createSoaSentinelValue(this, missType ?? ObjectType),
            ),
          );
          const logExtern = this.requireExternSignature(
            "Debug",
            "LogError",
            "method",
            ["object"],
            "void",
          );
          const errMsg = createConstant(
            `[udon-assembly-ts] D3 dispatch miss (limit exceeded): ${node.property} on untracked instance`,
            PrimitiveTypes.string,
          );
          this.emit(new CallInstruction(undefined, logExtern, [errMsg]));
          return missResult;
        }
      }
    }

    const objectType = this.getOperandType(object);

    // Native array .length → __get_Length__ (not DataList.Count).
    if (
      objectType instanceof NativeArrayTypeSymbol &&
      node.property === "length"
    ) {
      const result = this.newTemp(PrimitiveTypes.int32);
      this.emit(new PropertyGetInstruction(result, object, "Length"));
      return result;
    }

    // Early return for .length on arrays — always int32.
    // Arrays are backed by DataList, so use "Count" property.
    if (objectType instanceof ArrayTypeSymbol && node.property === "length") {
      const result = this.newTemp(PrimitiveTypes.int32);
      const countObject = ensureDataListForCount(this, object);
      this.emit(new PropertyGetInstruction(result, countObject, "Count"));
      return result;
    }

    // DataList .length → .Count mapping with int32 return type.
    if (
      (objectType instanceof DataListTypeSymbol ||
        objectType.name === ExternTypes.dataList.name ||
        objectType.udonType === UdonType.DataList) &&
      node.property === "length"
    ) {
      const result = this.newTemp(PrimitiveTypes.int32);
      const countObject = ensureDataListForCount(this, object);
      this.emit(new PropertyGetInstruction(result, countObject, "Count"));
      return result;
    }

    // Iterator result `.value` on DataToken (`map.keys().next().value` etc).
    // Prefer iterable element type / expected type before falling back to
    // `.Reference`, which is unsafe for primitive-backed tokens.
    if (
      objectType.name === ExternTypes.dataToken.name &&
      node.property === "value"
    ) {
      const tokenKey = operandTrackingKey(object);
      if (tokenKey) {
        const hintedValueType = this.dataTokenValueHints.get(tokenKey);
        if (hintedValueType) {
          if (object.kind === TACOperandKind.Temporary) {
            this.dataTokenValueHints.delete(tokenKey);
          }
          if (!isPlainObjectType(hintedValueType)) {
            return this.unwrapDataToken(object, hintedValueType);
          }
        }
      }
      const iteratorValueType = resolveIteratorValueTypeFromNextCall(
        this,
        node.object,
      );
      if (iteratorValueType && !isPlainObjectType(iteratorValueType)) {
        return this.unwrapDataToken(object, iteratorValueType);
      }
      const expected = this.currentExpectedType;
      if (expected && !isPlainObjectType(expected)) {
        return this.unwrapDataToken(object, expected);
      }
      const result = this.newTemp(ObjectType);
      this.emit(new PropertyGetInstruction(result, object, "Reference"));
      return result;
    }

    const resolvedBaseType = resolveTypeFromNode(this, node.object);
    const isSet =
      isSetCollectionType(objectType) || isSetCollectionType(resolvedBaseType);
    const isMap =
      isMapCollectionType(objectType) || isMapCollectionType(resolvedBaseType);
    if ((isSet || isMap) && node.property === "size") {
      const result = this.newTemp(PrimitiveTypes.int32);
      this.emit(new PropertyGetInstruction(result, object, "Count"));
      return result;
    }
    let resultType: TypeSymbol | undefined;
    if (
      node.object.kind === ASTNodeKind.ThisExpression &&
      this.currentClassName
    ) {
      const classNode = this.classMap.get(this.currentClassName);
      const prop = classNode?.properties.find((p) => p.name === node.property);
      if (prop) resultType = prop.type;
    } else if (this.classRegistry) {
      const classMeta = this.classRegistry.getClass(objectType.name);
      if (classMeta) {
        const prop = this.classRegistry.getMergedProperty(
          objectType.name,
          node.property,
        );
        if (prop) {
          resultType = prop.type;
        }
      } else {
        const interfaceMeta = this.classRegistry.getInterface(objectType.name);
        const prop = interfaceMeta?.properties.find(
          (candidate) => candidate.name === node.property,
        );
        if (prop) {
          resultType = prop.type;
        }
      }
    }
    if (!resultType) {
      const classNode = this.classMap.get(objectType.name);
      const prop = classNode?.properties.find((p) => p.name === node.property);
      if (prop) resultType = prop.type;
    }
    if (!resultType) {
      const baseType = resolveTypeFromNode(this, node.object);
      if (baseType) {
        resultType =
          resolvePropertyTypeFromType(this, baseType, node.property) ??
          resultType;
      }
    }
    if (
      objectType instanceof InterfaceTypeSymbol &&
      objectType.properties.has(node.property) &&
      !this.udonBehaviourClasses.has(objectType.name)
    ) {
      const missType = resultType ?? objectType.properties.get(node.property);
      const dispatched = tryEmitStructuralInterfacePropertyDispatch(
        this,
        object,
        objectType,
        node.property,
        missType ?? ObjectType,
      );
      if (dispatched) return dispatched;
      const missResult = this.newTemp(missType ?? ObjectType);
      this.emit(
        new AssignmentInstruction(
          missResult,
          createSoaSentinelValue(this, missType ?? ObjectType),
        ),
      );
      const logExtern = this.requireExternSignature(
        "Debug",
        "LogError",
        "method",
        ["object"],
        "void",
      );
      this.emit(
        new CallInstruction(undefined, logExtern, [
          createConstant(
            `[udon-assembly-ts] structural dispatch miss: ${node.property} on untracked interface value`,
            PrimitiveTypes.string,
          ),
        ]),
      );
      return missResult;
    }
    const structuralBaseInterface = resolveStructuralInterface(
      this,
      resolvedBaseType ?? undefined,
    );
    if (
      structuralBaseInterface &&
      structuralBaseInterface.properties.has(node.property) &&
      !this.udonBehaviourClasses.has(structuralBaseInterface.name)
    ) {
      const missType =
        resultType ??
        resolveStructuralPropertyType(
          this,
          structuralBaseInterface,
          node.property,
        ) ??
        ObjectType;
      const dispatched = tryEmitStructuralInterfacePropertyDispatch(
        this,
        object,
        structuralBaseInterface,
        node.property,
        missType,
      );
      if (dispatched) return dispatched;
      const missResult = this.newTemp(missType);
      this.emit(
        new AssignmentInstruction(
          missResult,
          createSoaSentinelValue(this, missType),
        ),
      );
      const logExtern = this.requireExternSignature(
        "Debug",
        "LogError",
        "method",
        ["object"],
        "void",
      );
      this.emit(
        new CallInstruction(undefined, logExtern, [
          createConstant(
            `[udon-assembly-ts] structural dispatch miss: ${node.property} on untracked structural handle`,
            PrimitiveTypes.string,
          ),
        ]),
      );
      return missResult;
    }
    const result = this.newTemp(resultType ?? ObjectType);

    this.emit(new PropertyGetInstruction(result, object, node.property));
    return result;
  } finally {
    this.propertyAccessDepth -= 1;
  }
}

export function visitThisExpression(
  this: ASTToTACConverter,
  _node: ThisExpressionNode,
): TACOperand {
  if (this.currentThisOverride) {
    return this.currentThisOverride;
  }
  if (this.currentInlineContext) {
    const { instancePrefix } = this.currentInlineContext;
    return createVariable(`${instancePrefix}__handle`, ObjectType);
  }
  const classType = this.currentClassName
    ? new ClassTypeSymbol(this.currentClassName, UdonType.Object)
    : ObjectType;
  return createVariable("this", classType);
}

export function visitSuperExpression(
  this: ASTToTACConverter,
  _node: SuperExpressionNode,
): TACOperand {
  return createVariable("this", ObjectType);
}

export function visitObjectLiteralExpression(
  this: ASTToTACConverter,
  node: ObjectLiteralExpressionNode,
): TACOperand {
  const expected = this.currentExpectedType;
  if (
    expected instanceof InterfaceTypeSymbol &&
    expected.properties.size > 0 &&
    !node.properties.some((p) => p.kind === "spread")
  ) {
    const className = expected.name;
    // Register the InterfaceTypeSymbol so mapInlineProperty can resolve properties
    if (!this.typeMapper.getAlias(className)) {
      this.typeMapper.registerTypeAlias(className, expected);
    }
    const enclosingInstancePrefix = this.currentInlineContext?.instancePrefix;
    const isNonSoAConstructorInitializer =
      this.currentInlineConstructorClassName !== undefined &&
      enclosingInstancePrefix !== undefined &&
      !this.soaInstancePrefixes.has(enclosingInstancePrefix);
    const isEscapingMeldShape =
      className.includes("isOpen:bool") &&
      className.includes("tiles:Tile[]") &&
      className.includes("type:string");
    const hasMethodInterfaceField = Array.from(
      expected.properties.values(),
    ).some((type) => {
      const iface = resolveStructuralInterface(this, type);
      return iface !== undefined && iface.methods.size > 0;
    });
    const structuralRuntimeContext =
      this.loopContextStack.length > 0 ||
      isEscapingMeldShape ||
      hasMethodInterfaceField;
    const literalIsInRuntimeLoopContext =
      structuralRuntimeContext &&
      (!isNonSoAConstructorInitializer ||
        isEscapingMeldShape ||
        hasMethodInterfaceField) &&
      (enclosingInstancePrefix === undefined ||
        this.soaInstancePrefixes.has(enclosingInstancePrefix) ||
        isEscapingMeldShape ||
        hasMethodInterfaceField);
    const soaEligible = !className.includes("YakuHanConfig");
    if (literalIsInRuntimeLoopContext && soaEligible) {
      this.soaClasses.add(className);
    }
    const isSoA = literalIsInRuntimeLoopContext && soaEligible;
    if (isSoA) {
      initSoaForStructuralInterface(this, className, expected);
    }
    // Deduplicate object literal instances across repeated method body inlinings.
    // When inside an inlined method body, reuse the same prefix/instanceId for
    // the Nth object literal in that body across all inlinings of the same body.
    const { instancePrefix, instanceId } = this.allocateBodyCachedInstance(
      className,
      isSoA ? "soa" : "static",
    );
    // Use Int32 handle (same as visitInlineConstructor) so allInlineInstances
    // dispatch can match by instanceId at runtime.
    const instanceHandle = createVariable(
      `${instancePrefix}__handle`,
      PrimitiveTypes.int32,
    );
    if (isSoA) {
      const counterVar = this.soaCounterVars.get(className);
      if (counterVar) {
        this.emit(new CopyInstruction(instanceHandle, counterVar));
      }
    } else {
      this.emit(
        new AssignmentInstruction(
          instanceHandle,
          createConstant(instanceId, PrimitiveTypes.int32),
        ),
      );
    }
    this.inlineInstanceMap.set(instanceHandle.name, {
      prefix: instancePrefix,
      className,
    });
    this.allInlineInstances.set(instanceId, {
      prefix: instancePrefix,
      className,
    });
    this.allInlineInstanceIdsByPrefix.set(instancePrefix, instanceId);
    this.structuralFieldPrefixes.add(instancePrefix);
    const instanceFieldTypes =
      this.structuralFieldPrefixTypes.get(instancePrefix) ??
      new Map<string, TypeSymbol>();
    this.structuralFieldPrefixTypes.set(instancePrefix, instanceFieldTypes);
    if (className.startsWith("__anon_")) {
      this.anonymousInlineClassNames.add(className);
    }
    if (isSoA) {
      this.soaConstructionPrefixes.add(instancePrefix);
      this.soaInstancePrefixes.add(instancePrefix);
    }
    try {
      for (const prop of node.properties) {
        if (prop.kind !== "property") continue;
        const rawPropType = expected.properties.get(prop.key);
        // Re-resolve through typeMapper in case the property type was registered
        // before its type alias (e.g. Wind) was defined (parse-order issue).
        const propType = rawPropType?.name
          ? (this.typeMapper.getAlias(rawPropType.name) ?? rawPropType)
          : rawPropType;
        // Propagate expected type for nested typed object literals
        const prev = this.currentExpectedType;
        if (propType && propType !== ObjectType) {
          this.currentExpectedType = propType;
        } else {
          this.currentExpectedType = undefined;
        }
        const value = this.visitExpression(prop.value);
        this.currentExpectedType = prev;
        const propStorageType =
          propType && propType !== ObjectType
            ? propType
            : this.getOperandType(value);
        const propVar = createVariable(
          `${instancePrefix}_${prop.key}`,
          propStorageType,
        );
        instanceFieldTypes.set(prop.key, propStorageType);
        this.emitCopyWithTracking(propVar, value);
        this.maybeTrackInlineInstanceAssignment(propVar, value);
        const propKey = operandTrackingKey(propVar);
        if (propKey) {
          const valueKey = operandTrackingKey(value);
          const structuralCopyType =
            propStorageType !== ObjectType
              ? propStorageType
              : (resolveTypeFromNode(this, prop.value) ??
                propType ??
                this.getOperandType(value));
          const propIsUntrackedStructuralHandle =
            this.untrackedStructuralHandleVars.has(propKey) ||
            (valueKey
              ? this.untrackedStructuralHandleVars.has(valueKey) ||
                valueKey.startsWith("__uninst_prop_")
              : false);
          if (!propIsUntrackedStructuralHandle) {
            emitStructuralFieldCopies(
              this,
              propKey,
              structuralCopyType,
              value,
            );
          }
          if (
            resolveStructuralInterface(this, structuralCopyType) &&
            this.untrackedStructuralHandleVars.has(propKey)
          ) {
            emitStructuralFieldsFromKnownHandle(
              this,
              propKey,
              structuralCopyType,
              value,
            );
          }
        }
      }
    } finally {
      if (isSoA) {
        this.soaConstructionPrefixes.delete(instancePrefix);
      }
    }
    if (isSoA) {
      const fieldLists = this.soaFieldLists.get(className);
      const fieldTypes = this.soaFieldTypes.get(className);
      if (fieldLists) {
        for (const [fieldName, listVar] of fieldLists) {
          const scratchVar = createVariable(
            `${instancePrefix}_${fieldName}`,
            fieldTypes?.get(fieldName) ?? ObjectType,
          );
          const token = this.wrapDataToken(scratchVar);
          this.emit(
            new MethodCallInstruction(undefined, listVar, "Add", [token]),
          );
        }
      }
      const counterVar = this.soaCounterVars.get(className);
      if (counterVar) {
        this.emit(
          new BinaryOpInstruction(
            counterVar,
            counterVar,
            "+",
            createConstant(1, PrimitiveTypes.int32),
          ),
        );
      }
    }
    return instanceHandle;
  }
  return this.emitDictionaryFromProperties(node.properties, node);
}

export function visitDeleteExpression(
  this: ASTToTACConverter,
  node: DeleteExpressionNode,
): TACOperand {
  if (node.target.kind === ASTNodeKind.PropertyAccessExpression) {
    const propAccess = node.target as PropertyAccessExpressionNode;
    const object = this.visitExpression(propAccess.object);
    if (this.isUdonBehaviourPropertyAccess(propAccess)) {
      const externSig = this.requireExternSignature(
        "UdonBehaviour",
        "SetProgramVariable",
        "method",
        ["string", "object"],
        "void",
      );
      const propName = createConstant(
        propAccess.property,
        PrimitiveTypes.string,
      );
      const nullValue = createConstant(null, ObjectType);
      this.emit(
        new CallInstruction(undefined, externSig, [
          object,
          propName,
          nullValue,
        ]),
      );
      return createConstant(true, PrimitiveTypes.boolean);
    }
    const objectType = this.getOperandType(object);
    if (objectType.name === ExternTypes.dataDictionary.name) {
      const keyToken = this.wrapDataToken(
        createConstant(propAccess.property, PrimitiveTypes.string),
      );
      const result = this.newTemp(PrimitiveTypes.boolean);
      this.emit(
        new MethodCallInstruction(result, object, "Remove", [keyToken]),
      );
      return result;
    }
    const nullValue = createConstant(null, ObjectType);
    this.emit(
      new PropertySetInstruction(object, propAccess.property, nullValue),
    );
    return createConstant(true, PrimitiveTypes.boolean);
  }

  if (node.target.kind === ASTNodeKind.ArrayAccessExpression) {
    const arrayAccess = node.target as ArrayAccessExpressionNode;
    const array = this.visitExpression(arrayAccess.array);
    const prevExpectedType = this.currentExpectedType;
    this.currentExpectedType = PrimitiveTypes.int32;
    let index: TACOperand;
    try {
      index = this.visitExpression(arrayAccess.index);
    } finally {
      this.currentExpectedType = prevExpectedType;
    }
    const objectType = this.getOperandType(array);
    if (objectType.name === ExternTypes.dataDictionary.name) {
      const keyToken = this.wrapDataToken(index);
      const result = this.newTemp(PrimitiveTypes.boolean);
      this.emit(new MethodCallInstruction(result, array, "Remove", [keyToken]));
      return result;
    }
    // delete arr[i] → set_Item(i, DataToken(null))
    const nullValue = createConstant(null, ObjectType);
    let coercedIndex = index;
    const idxType = this.getOperandType(index);
    if (needsInt32IndexCoercion(idxType.udonType)) {
      const intIndex = this.newTemp(PrimitiveTypes.int32);
      this.emit(new CastInstruction(intIndex, index));
      coercedIndex = intIndex;
    }
    const token = this.wrapDataToken(nullValue);
    this.emit(
      new MethodCallInstruction(undefined, array, "set_Item", [
        coercedIndex,
        token,
      ]),
    );
    return createConstant(true, PrimitiveTypes.boolean);
  }

  this.visitExpression(node.target);
  return createConstant(true, PrimitiveTypes.boolean);
}

export function visitOptionalChainingExpression(
  this: ASTToTACConverter,
  node: OptionalChainingExpressionNode,
): TACOperand {
  const obj = this.visitExpression(node.object);
  const objTemp = this.newTemp(this.getOperandType(obj));
  this.emitCopyWithTracking(objTemp, obj);
  const objTempName = operandTrackingKey(objTemp);
  if (objTempName) {
    emitStructuralFieldCopies(
      this,
      objTempName,
      this.getOperandType(objTemp),
      obj,
      { isLocal: true },
      true,
    );
  }

  let resultType: TypeSymbol | undefined;
  if (
    node.object.kind === ASTNodeKind.ThisExpression &&
    this.currentClassName
  ) {
    const classNode = this.classMap.get(this.currentClassName);
    const prop = classNode?.properties.find((p) => p.name === node.property);
    if (prop) resultType = prop.type;
  } else if (this.classRegistry) {
    const objectType = this.getOperandType(objTemp);
    const classMeta = this.classRegistry.getClass(objectType.name);
    if (classMeta) {
      const prop = this.classRegistry.getMergedProperty(
        objectType.name,
        node.property,
      );
      if (prop) {
        resultType = prop.type;
      }
    } else {
      const interfaceMeta = this.classRegistry.getInterface(objectType.name);
      const prop = interfaceMeta?.properties.find(
        (candidate) => candidate.name === node.property,
      );
      if (prop) {
        resultType = prop.type;
      }
    }
  }

  const isNull = this.newTemp(PrimitiveTypes.boolean);
  const objTempType = this.getOperandType(objTemp);
  const objTempUsesInlineSentinel =
    usesInlineNullSentinel(this, objTempType) ||
    (objTempName !== undefined &&
      (this.inlineInstanceMap.has(objTempName) ||
        this.untrackedStructuralHandleVars.has(objTempName) ||
        this.structuralFieldPrefixes.has(objTempName)));
  if (objTempUsesInlineSentinel) {
    // Inline-handle receivers store null as the sentinel `-1` rather than a
    // null object reference. Boxing the Int32 into an Object slot and then
    // comparing against null would always return false (the box exists), so
    // `inlineHandle?.method()` would never short-circuit. Mirror the
    // sentinel branch already in visitNullCoalescingExpression.
    const handleInt32 = normalizeOperandToInt32(this, objTemp);
    this.emit(
      new BinaryOpInstruction(
        isNull,
        handleInt32,
        "==",
        createConstant(-1, PrimitiveTypes.int32),
      ),
    );
  } else {
    const nullCheckOperand = this.newTemp(ObjectType);
    this.emit(new CopyInstruction(nullCheckOperand, objTemp));
    this.emit(
      new BinaryOpInstruction(
        isNull,
        nullCheckOperand,
        "==",
        createConstant(null, ObjectType),
      ),
    );
  }
  const notNullLabel = this.newLabel("opt_notnull");
  const endLabel = this.newLabel("opt_end");
  const fallbackPropertyType =
    inferInlineStructuralPropertyType(this, node.property) ??
    this.fieldTypeRegistry.getStructuralFieldType(node.property);
  const effectiveResultType = resultType ?? fallbackPropertyType;
  const result = this.newTemp(effectiveResultType ?? ObjectType);
  this.emit(new ConditionalJumpInstruction(isNull, notNullLabel));
  this.emit(
    new AssignmentInstruction(
      result,
      createSoaSentinelValue(this, effectiveResultType ?? ObjectType),
    ),
  );
  this.emit(new UnconditionalJumpInstruction(endLabel));

  this.emit(new LabelInstruction(notNullLabel));
  // Create a named variable to hold objTemp so visitPropertyAccessExpression
  // can look it up by name and get proper inline tracking. Use a temporary
  // scope to avoid leaking the symbol into the enclosing scope.
  const resolvedOptBaseType = resolveTypeFromNode(this, node.object);
  const optBaseType =
    resolvedOptBaseType && !isPlainObjectType(resolvedOptBaseType)
      ? resolvedOptBaseType
      : this.getOperandType(objTemp);
  const optBaseName = `__opt_base_${this.tempCounter++}`;
  const optBase = createVariable(optBaseName, optBaseType, { isLocal: true });
  this.symbolTable.enterScope();
  let propResult: TACOperand;
  try {
    this.symbolTable.addSymbol(optBaseName, optBaseType);
    this.emit(new CopyInstruction(optBase, objTemp));
    // Propagate inline instance tracking from objTemp to optBase
    this.maybeTrackInlineInstanceAssignment(optBase, objTemp, false);
    emitStructuralFieldCopies(
      this,
      optBaseName,
      optBaseType,
      objTemp,
      { isLocal: true },
      true,
    );
    const structuralPropertyType =
      effectiveResultType ??
      this.fieldTypeRegistry.getStructuralFieldType(node.property);
    if (structuralPropertyType) {
      propResult =
        tryReadPopulatedStructuralFieldSlot(
          this,
          optBaseName,
          optBaseType,
          node.property,
        ) ??
        tryReadInlineFieldByHandle(
          this,
          optBase,
          node.property,
          structuralPropertyType,
        ) ??
        this.visitPropertyAccessExpression({
          kind: ASTNodeKind.PropertyAccessExpression,
          object: {
            kind: ASTNodeKind.Identifier,
            name: optBaseName,
          } as IdentifierNode,
          property: node.property,
        } as PropertyAccessExpressionNode);
    } else {
      propResult = this.visitPropertyAccessExpression({
        kind: ASTNodeKind.PropertyAccessExpression,
        object: {
          kind: ASTNodeKind.Identifier,
          name: optBaseName,
        } as IdentifierNode,
        property: node.property,
      } as PropertyAccessExpressionNode);
    }
  } finally {
    this.symbolTable.exitScope();
  }
  this.emitCopyWithTracking(result, propResult);
  this.emit(new LabelInstruction(endLabel));

  return result;
}

export function visitAsExpression(
  this: ASTToTACConverter,
  node: AsExpressionNode,
): TACOperand {
  const targetTypeText = node.targetType.trim();
  if (targetTypeText === "const") {
    return this.visitExpression(node.expression);
  }
  const targetTypeSymbol = node.targetTypeSymbol;
  const prevExpectedType = this.currentExpectedType;
  this.currentExpectedType = targetTypeSymbol;
  let operand: TACOperand;
  try {
    operand = this.visitExpression(node.expression);
  } finally {
    this.currentExpectedType = prevExpectedType;
  }
  const srcType = this.getOperandType(operand);
  // F2: `x as number` is a TypeScript brand-strip, not a float conversion.
  // When the source is already an integer type, preserve it so downstream
  // arithmetic stays in the integer lane (e.g. UdonInt → number → subtract).
  // This covers all integer widths (Int32, Int64, UInt64, Int16, UInt16, Byte,
  // SByte): `someInt64 as number` returns the Int64 operand unchanged rather
  // than narrowing to Single. TypeScript's `as` is a compile-time assertion, so
  // this matches the brand-strip intent. Users who need an explicit float
  // conversion should write `someValue as SystemSingle` or `as UdonFloat`.
  if (
    targetTypeText === "number" &&
    NUMERIC_UDON_TYPES.has(srcType.udonType) &&
    !FLOAT_UDON_TYPES.has(srcType.udonType)
  ) {
    return operand;
  }
  const result = this.newTemp(targetTypeSymbol);
  // Use CastInstruction for numeric type conversions (e.g. float→int);
  // use COPY for same-type or reference-type casts.
  if (srcType.udonType !== targetTypeSymbol.udonType) {
    if (
      NUMERIC_UDON_TYPES.has(srcType.udonType) &&
      NUMERIC_UDON_TYPES.has(targetTypeSymbol.udonType)
    ) {
      // Fold constant numeric casts at compile time (e.g. `0 as UdonInt`
      // becomes a direct %SystemInt32 constant instead of 3 extern calls).
      // Skip float→float casts (e.g. Single→Double) because JS number (f64)
      // does not round-trip through f32, causing a precision mismatch.
      if (
        operand.kind === TACOperandKind.Constant &&
        !(
          FLOAT_UDON_TYPES.has(srcType.udonType) &&
          FLOAT_UDON_TYPES.has(targetTypeSymbol.udonType)
        )
      ) {
        const srcConst = operand as ConstantOperand;
        if (
          isPrimitiveFoldValue(srcConst.value) &&
          canFoldNumericLiteral(srcConst.value, targetTypeSymbol.udonType)
        ) {
          const foldedValue = evaluateCastValue(
            srcConst.value,
            targetTypeSymbol,
          );
          if (foldedValue !== null) {
            this.emit(
              new AssignmentInstruction(
                result,
                createConstant(foldedValue, targetTypeSymbol),
              ),
            );
            return result;
          }
        }
      }
      this.emit(new CastInstruction(result, operand));
    } else if (
      srcType.udonType === UdonType.DataToken &&
      (NUMERIC_UDON_TYPES.has(targetTypeSymbol.udonType) ||
        targetTypeSymbol.udonType === UdonType.Boolean ||
        targetTypeSymbol.udonType === UdonType.String ||
        targetTypeSymbol.udonType === UdonType.DataList ||
        targetTypeSymbol.udonType === UdonType.Array ||
        targetTypeSymbol.udonType === UdonType.DataDictionary)
    ) {
      // DataToken assertions to concrete targets use typed token accessors.
      // This includes erased Map<string, unknown> values that are asserted back
      // to arrays/DataLists after leaving a generic cache.
      const unwrapped = this.unwrapDataToken(operand, targetTypeSymbol);
      if (unwrapped !== operand) {
        this.emitCopyWithTracking(result, unwrapped);
      } else {
        this.emit(new CastInstruction(result, operand));
      }
    } else if (
      srcType.udonType !== UdonType.Object &&
      (NUMERIC_UDON_TYPES.has(targetTypeSymbol.udonType) ||
        targetTypeSymbol.udonType === UdonType.Boolean ||
        (targetTypeSymbol.udonType === UdonType.String &&
          (NUMERIC_UDON_TYPES.has(srcType.udonType) ||
            srcType.udonType === UdonType.Boolean)))
    ) {
      this.emit(new CastInstruction(result, operand));
    } else {
      this.emitCopyWithTracking(result, operand);
    }
  } else {
    this.emitCopyWithTracking(result, operand);
  }
  const resultKey = operandTrackingKey(result);
  if (resultKey) {
    emitStructuralFieldCopies(this, resultKey, targetTypeSymbol, operand, {
      isLocal: true,
    });
  }
  return result;
}

export function visitNameofExpression(
  this: ASTToTACConverter,
  node: NameofExpressionNode,
): TACOperand {
  return createConstant(node.name, PrimitiveTypes.string);
}

export function visitTypeofExpression(
  this: ASTToTACConverter,
  node: TypeofExpressionNode,
): TACOperand {
  const qualifiedName = typeSymbolToCSharp(node.typeSymbol);
  const typeNameConst = createConstant(qualifiedName, PrimitiveTypes.string);
  const result = this.newTemp(ExternTypes.systemType);
  const externSig = this.requireExternSignature(
    "Type",
    "GetType",
    "method",
    ["string"],
    "Type",
  );
  this.emit(new CallInstruction(result, externSig, [typeNameConst]));
  return result;
}
