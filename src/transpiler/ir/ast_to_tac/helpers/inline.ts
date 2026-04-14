import type { TypeSymbol } from "../../../frontend/type_symbols.js";
import {
  ClassTypeSymbol,
  DataListTypeSymbol,
  ExternTypes,
  InterfaceTypeSymbol,
  ObjectType,
  PrimitiveTypes,
} from "../../../frontend/type_symbols.js";

/**
 * Maximum recursion depth for @RecursiveMethod. Shared between stack
 * allocation (statement.ts) and the overflow guard (emitCallSitePush).
 */
export const MAX_RECURSION_STACK_DEPTH = 16;

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
  type ClassDeclarationNode,
  type ConditionalExpressionNode,
  type DeleteExpressionNode,
  type DoWhileStatementNode,
  type ExpressionStatementNode,
  type ForOfStatementNode,
  type ForStatementNode,
  type IdentifierNode,
  type IfStatementNode,
  isNumericUdonType,
  type MethodDeclarationNode,
  type NullCoalescingExpressionNode,
  type ObjectLiteralExpressionNode,
  type OptionalChainingExpressionNode,
  type PropertyAccessExpressionNode,
  type PropertyDeclarationNode,
  type ReturnStatementNode,
  type SwitchStatementNode,
  type TemplateExpressionNode,
  type ThrowStatementNode,
  type TryCatchStatementNode,
  UdonType,
  type UnaryExpressionNode,
  type UpdateExpressionNode,
  type VariableDeclarationNode,
  type WhileStatementNode,
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
  ReturnInstruction,
  UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import {
  createConstant,
  createLabel,
  createVariable,
  type LabelOperand,
  type TACOperand,
  TACOperandKind,
  type TemporaryOperand,
  type VariableOperand,
} from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";
import { analyzeNativeArrayIneligibility } from "./native_array_analysis.js";

export type InlineParamSave = Map<
  string,
  { prefix: string; className: string } | undefined
>;
type InlineInitializerState = NonNullable<
  ASTToTACConverter["currentInlineInitializerState"]
>;

/**
 * Check if a type represents an inline class instance stored as an Int32 handle.
 * Inline class instances are NOT UdonBehaviour types and have entries in the
 * classMap or interfaceClassIdMap.
 */
export function isInlineHandleType(
  converter: ASTToTACConverter,
  type: TypeSymbol,
): boolean {
  return (
    (type instanceof ClassTypeSymbol &&
      converter.classMap.has(type.name) &&
      !converter.udonBehaviourClasses.has(type.name)) ||
    (type instanceof InterfaceTypeSymbol &&
      converter.interfaceClassIdMap.has(type.name))
  );
}

/**
 * Check whether `className` is equal to or a subclass of `baseName`
 * according to the class registry's inheritance chain.
 */
export function isSubclassOf(
  converter: ASTToTACConverter,
  className: string,
  baseName: string,
): boolean {
  return (
    converter.classRegistry
      ?.getInheritanceChain(className)
      .includes(baseName) ?? false
  );
}

/**
 * Resolve a class node by name, checking classMap first then classRegistry.
 */
export function resolveClassNode(
  converter: ASTToTACConverter,
  className: string,
): ClassDeclarationNode | undefined {
  let classNode = converter.classMap.get(className);
  if (!classNode && converter.classRegistry) {
    const meta = converter.classRegistry.getClass(className);
    if (
      meta &&
      !converter.udonBehaviourClasses.has(className) &&
      !converter.classRegistry.isStub(className)
    ) {
      classNode = meta.node;
      converter.classMap.set(className, classNode);
    }
  }
  return classNode;
}

export function saveAndBindInlineParams(
  converter: ASTToTACConverter,
  params: Array<{ name: string; type: TypeSymbol }>,
  args: TACOperand[],
): InlineParamSave {
  const argInlineInfos = args.map((arg) => {
    if (!arg) return undefined;
    const key = operandTrackingKey(arg);
    return key ? converter.resolveInlineInstance(key) : undefined;
  });
  const saved: InlineParamSave = new Map();
  for (let i = 0; i < params.length; i++) {
    const param = params[i];
    if (!converter.symbolTable.hasInCurrentScope(param.name)) {
      converter.symbolTable.addSymbol(param.name, param.type, true, false);
    }
    saved.set(param.name, converter.inlineInstanceMap.get(param.name));
    converter.inlineInstanceMap.delete(param.name);
    const arg = args[i];
    if (arg) {
      // Coerce argument type if both are numeric but different.
      // Without this, a COPY from Single (float) to Int32 would do a
      // bitwise transfer and corrupt the value (e.g. 25000.0 → 0).
      let argToUse = arg;
      const argType = converter.getOperandType(arg);
      if (
        argType.udonType !== param.type.udonType &&
        isNumericUdonType(argType.udonType) &&
        isNumericUdonType(param.type.udonType)
      ) {
        const coercedArg = converter.newTemp(param.type);
        converter.instructions.push(new CastInstruction(coercedArg, arg));
        argToUse = coercedArg;
      }
      converter.instructions.push(
        new CopyInstruction(
          createVariable(param.name, param.type, { isParameter: true }),
          argToUse,
        ),
      );
      const argInfo = argInlineInfos[i];
      if (argInfo) {
        converter.inlineInstanceMap.set(param.name, argInfo);
      } else if (arg.kind === TACOperandKind.Variable) {
        const argVar = arg as VariableOperand;
        // Only real heap-prefix variables can be rebound this way. Synthetic
        // return temps like `__inline_ret_*` may be untracked even though they
        // look prefix-like, so letting them masquerade as instances is unsafe.
        const isHeapPrefix =
          argVar.name.startsWith("__inst_") ||
          argVar.name.startsWith("__viface_");
        if (!isHeapPrefix) continue;

        const argType = converter.getOperandType(argVar);
        const isTypeAlias =
          converter.typeMapper.getAlias(argType.name) instanceof
          InterfaceTypeSymbol;
        const isInlineClass =
          resolveClassNode(converter, argType.name) !== undefined &&
          !converter.udonBehaviourClasses.has(argType.name);
        if (isTypeAlias || isInlineClass) {
          converter.inlineInstanceMap.set(param.name, {
            prefix: argVar.name,
            className: argType.name,
          });
        } else {
          // Fallback: when the argument's operand type is erased (e.g.
          // ObjectType from a Map.get or conditional), try the parameter's
          // declared type. The method signature is more reliable than the
          // operand's runtime type in this case.
          const paramTypeName = param.type.name;
          const isParamTypeAlias =
            converter.typeMapper.getAlias(paramTypeName) instanceof
            InterfaceTypeSymbol;
          const isParamInlineClass =
            resolveClassNode(converter, paramTypeName) !== undefined &&
            !converter.udonBehaviourClasses.has(paramTypeName);
          if (isParamTypeAlias || isParamInlineClass) {
            converter.inlineInstanceMap.set(param.name, {
              prefix: argVar.name,
              className: paramTypeName,
            });
          }
        }
      } else if (param.type.udonType === UdonType.Boolean) {
        converter.instructions.push(
          new CopyInstruction(
            createVariable(param.name, param.type, { isParameter: true }),
            createConstant(false, PrimitiveTypes.boolean),
          ),
        );
      }
    }
  }
  return saved;
}

export function restoreInlineParams(
  converter: ASTToTACConverter,
  saved: InlineParamSave,
): void {
  for (const [name, entry] of saved) {
    if (entry === undefined) {
      converter.inlineInstanceMap.delete(name);
    } else {
      converter.inlineInstanceMap.set(name, entry);
    }
  }
}

function getEntryPointPropertyNameForClass(
  converter: ASTToTACConverter,
  entryClassName: string,
  property: string,
): string {
  if (converter.entryPointClasses.size > 1) {
    return `${entryClassName}__${property}`;
  }
  return property;
}

function buildInheritanceChain(
  converter: ASTToTACConverter,
  classNode: ClassDeclarationNode,
): ClassDeclarationNode[] {
  const inheritanceChain: ClassDeclarationNode[] = [];
  const visited = new Set<string>();
  let current: ClassDeclarationNode | undefined = classNode;
  while (current) {
    if (visited.has(current.name)) break; // cycle guard
    visited.add(current.name);
    inheritanceChain.unshift(current);
    if (current.baseClass) {
      current = resolveClassNode(converter, current.baseClass);
    } else {
      break;
    }
  }
  return inheritanceChain;
}

/**
 * Collect all non-static instance fields from a class and its ancestors,
 * in inheritance order (base first). Deduplicates by field name.
 */
function collectAllInstanceFields(
  converter: ASTToTACConverter,
  classNode: ClassDeclarationNode,
): Array<{ name: string; type: TypeSymbol }> {
  const chain = buildInheritanceChain(converter, classNode);
  const fields: Array<{ name: string; type: TypeSymbol }> = [];
  const seen = new Set<string>();
  for (const cls of chain) {
    for (const prop of cls.properties) {
      if (prop.isStatic || seen.has(prop.name)) continue;
      seen.add(prop.name);
      fields.push({ name: prop.name, type: prop.type });
    }
  }
  return fields;
}

/**
 * Lazily emit DataList constructors and counter initialization for a SoA class.
 * Idempotent: no-ops if already initialized for this className.
 */
/**
 * Ensure per-field DataList operands and counter operand exist for a SoA class.
 * Memoized by soaInitialized — creates operands exactly once per class per pass.
 * Does NOT emit code; call emitSoaInitGuard separately.
 */
function ensureSoaOperands(
  converter: ASTToTACConverter,
  className: string,
  classNode: ClassDeclarationNode,
): void {
  if (converter.soaInitialized.has(className)) return;
  converter.soaInitialized.add(className);

  const fields = collectAllInstanceFields(converter, classNode);
  const fieldLists = new Map<string, VariableOperand>();
  const fieldTypes = new Map<string, TypeSymbol>();
  for (const field of fields) {
    fieldTypes.set(field.name, field.type);
    fieldLists.set(
      field.name,
      createVariable(
        `__soa_${className}_${field.name}`,
        new DataListTypeSymbol(ExternTypes.dataToken),
      ),
    );
  }
  converter.soaFieldLists.set(className, fieldLists);
  converter.soaFieldTypes.set(className, fieldTypes);
  converter.soaCounterVars.set(
    className,
    createVariable(`__soa_${className}__counter`, PrimitiveTypes.int32),
  );
}

function createSoaSentinelValue(
  converter: ASTToTACConverter,
  fieldType: TypeSymbol,
): TACOperand {
  if (isInlineHandleType(converter, fieldType)) {
    return createConstant(0, PrimitiveTypes.int32);
  }
  if (fieldType.udonType === UdonType.String) {
    return createConstant("", PrimitiveTypes.string);
  }
  if (fieldType.udonType === UdonType.Boolean) {
    return createConstant(false, PrimitiveTypes.boolean);
  }
  if (
    fieldType.udonType === UdonType.Int64 ||
    fieldType.udonType === UdonType.UInt64
  ) {
    return createConstant(0n, fieldType);
  }
  if (isNumericUdonType(fieldType.udonType)) {
    return createConstant(0, fieldType);
  }
  if (
    fieldType.udonType === UdonType.Array ||
    fieldType.udonType === UdonType.DataList
  ) {
    const listValue = converter.newTemp(ExternTypes.dataList);
    const listCtorSig = converter.requireExternSignature(
      "DataList",
      "ctor",
      "method",
      [],
      "DataList",
    );
    converter.instructions.push(
      new CallInstruction(listValue, listCtorSig, []),
    );
    return listValue;
  }
  if (fieldType.udonType === UdonType.DataDictionary) {
    const dictValue = converter.newTemp(ExternTypes.dataDictionary);
    const dictCtorSig = converter.requireExternSignature(
      "DataDictionary",
      "ctor",
      "method",
      [],
      "DataDictionary",
    );
    converter.instructions.push(
      new CallInstruction(dictValue, dictCtorSig, []),
    );
    return dictValue;
  }
  return createConstant(null, ObjectType);
}

/**
 * Emit a runtime-guarded init block for a SoA class.
 * Called at every constructor call site so that whichever site executes first
 * at runtime performs the initialisation (DataList construction, counter = 1,
 * sentinel entries at index 0). The __soa_<class>__inited flag ensures the
 * block runs at most once at runtime.
 */
function emitSoaInitGuard(
  converter: ASTToTACConverter,
  className: string,
): void {
  const fieldLists = converter.soaFieldLists.get(className);
  const fieldTypes = converter.soaFieldTypes.get(className);
  const counterVar = converter.soaCounterVars.get(className);
  if (!fieldLists || !fieldTypes || !counterVar) return;

  const initedVar = createVariable(
    `__soa_${className}__inited`,
    PrimitiveTypes.int32,
  );
  const notYetInited = converter.newTemp(PrimitiveTypes.boolean);
  const skipInitLabel = converter.newLabel("soa_init_skip");
  converter.instructions.push(
    new BinaryOpInstruction(
      notYetInited,
      initedVar,
      "==",
      createConstant(0, PrimitiveTypes.int32),
    ),
  );
  // ConditionalJump uses JUMP_IF_FALSE: jumps when notYetInited is false
  // (i.e. already initialized) — skips the init block.
  converter.instructions.push(
    new ConditionalJumpInstruction(notYetInited, skipInitLabel),
  );

  converter.instructions.push(
    new AssignmentInstruction(
      initedVar,
      createConstant(1, PrimitiveTypes.int32),
    ),
  );

  const listCtorSig = converter.requireExternSignature(
    "DataList",
    "ctor",
    "method",
    [],
    "DataList",
  );
  for (const [, listVar] of fieldLists) {
    converter.instructions.push(new CallInstruction(listVar, listCtorSig, []));
  }

  // Counter starts at 1: Udon zero-initialises heap slots, so an
  // uninitialised array element holds 0. Reserving handle 0 as "no valid
  // instance" prevents false SoA lookups on partially-populated arrays
  // (consistent with the non-SoA nextInstanceId starting at 1).
  converter.instructions.push(
    new AssignmentInstruction(
      counterVar,
      createConstant(1, PrimitiveTypes.int32),
    ),
  );

  // Reserve index 0 as a sentinel in each DataList so that handle values
  // (starting at 1) align with DataList indices.
  for (const [fieldName, listVar] of fieldLists) {
    const fieldType = fieldTypes.get(fieldName) ?? ObjectType;
    const dummyToken = converter.wrapDataToken(
      createSoaSentinelValue(converter, fieldType),
    );
    converter.instructions.push(
      new MethodCallInstruction(undefined, listVar, "Add", [dummyToken]),
    );
  }

  converter.instructions.push(new LabelInstruction(skipInitLabel));
}

/**
 * Ensure SoA operands exist and emit a runtime-guarded init block.
 * The operand creation is memoized (once per class per pass), but the guard
 * block is emitted at every call site so that whichever constructor site
 * executes first at runtime performs the initialisation.
 */
function initSoaForClass(
  converter: ASTToTACConverter,
  className: string,
  classNode: ClassDeclarationNode,
): void {
  ensureSoaOperands(converter, className, classNode);
  emitSoaInitGuard(converter, className);
}

export function resolveClassProperty(
  converter: ASTToTACConverter,
  className: string,
  property: string,
):
  | {
      prop: PropertyDeclarationNode;
      declaringClassName: string;
    }
  | undefined {
  let current = resolveClassNode(converter, className);
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current.name)) break; // cycle guard
    visited.add(current.name);
    const prop = current.properties.find(
      (candidate) => candidate.name === property && !candidate.isStatic,
    );
    if (prop) {
      return { prop, declaringClassName: current.name };
    }
    if (!current.baseClass) break;
    current = resolveClassNode(converter, current.baseClass);
  }
  return undefined;
}

/**
 * Walk the inheritance chain to find an instance method by name.
 * Similar to resolveClassProperty but for methods.
 */
export function resolveClassMethod(
  converter: ASTToTACConverter,
  className: string,
  methodName: string,
  isStatic = false,
):
  | {
      method: MethodDeclarationNode;
      declaringClassName: string;
    }
  | undefined {
  let current = resolveClassNode(converter, className);
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current.name)) break;
    visited.add(current.name);
    const method = current.methods.find(
      (candidate) =>
        candidate.name === methodName && candidate.isStatic === isStatic,
    );
    if (method) {
      return { method, declaringClassName: current.name };
    }
    if (!current.baseClass) break;
    current = resolveClassNode(converter, current.baseClass);
  }
  return undefined;
}

export function resolveStaticClassProperty(
  converter: ASTToTACConverter,
  className: string,
  property: string,
):
  | {
      prop: PropertyDeclarationNode;
      declaringClassName: string;
    }
  | undefined {
  let current = resolveClassNode(converter, className);
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current.name)) break;
    visited.add(current.name);
    const prop = current.properties.find(
      (candidate) => candidate.name === property && candidate.isStatic,
    );
    if (prop) {
      return { prop, declaringClassName: current.name };
    }
    if (!current.baseClass) break;
    current = resolveClassNode(converter, current.baseClass);
  }
  return undefined;
}

export function mapStaticProperty(
  this: ASTToTACConverter,
  className: string,
  property: string,
): VariableOperand | undefined {
  const resolved = resolveStaticClassProperty(this, className, property);
  if (resolved) {
    // Late-resolve originalTypeName to match emitStaticPropertyInitializers,
    // ensuring reads and writes use the same resolved type for the heap slot.
    let propType = resolved.prop.type;
    if (
      resolved.prop.initializer?.kind === ASTNodeKind.ObjectLiteralExpression &&
      !(propType instanceof InterfaceTypeSymbol) &&
      resolved.prop.originalTypeName
    ) {
      const lateResolved = this.typeMapper.mapTypeScriptType(
        resolved.prop.originalTypeName,
      );
      if (
        lateResolved instanceof InterfaceTypeSymbol &&
        lateResolved.properties.size > 0
      ) {
        propType = lateResolved;
      }
    }
    return createVariable(
      `${resolved.declaringClassName}__${property}`,
      propType,
    );
  }
  return undefined;
}

export function emitStaticPropertyInitializers(
  converter: ASTToTACConverter,
  className: string,
): void {
  if (converter.emittedStaticClasses.has(className)) return;
  const classNode = resolveClassNode(converter, className);
  if (!classNode) return;
  converter.emittedStaticClasses.add(className);
  // Also emit for base classes first
  if (classNode.baseClass) {
    emitStaticPropertyInitializers(converter, classNode.baseClass);
  }
  for (const prop of classNode.properties) {
    if (!prop.initializer || !prop.isStatic) continue;
    const propVarName = `${classNode.name}__${prop.name}`;
    let resolvedPropType = prop.type;
    if (
      prop.initializer.kind === ASTNodeKind.ObjectLiteralExpression &&
      !(resolvedPropType instanceof InterfaceTypeSymbol) &&
      prop.originalTypeName
    ) {
      const lateResolved = converter.typeMapper.mapTypeScriptType(
        prop.originalTypeName,
      );
      if (
        lateResolved instanceof InterfaceTypeSymbol &&
        lateResolved.properties.size > 0
      ) {
        resolvedPropType = lateResolved;
      }
    }
    const propVar = createVariable(propVarName, resolvedPropType);
    const prevExpected = converter.currentExpectedType;
    if (
      prop.initializer.kind === ASTNodeKind.ObjectLiteralExpression &&
      resolvedPropType instanceof InterfaceTypeSymbol &&
      resolvedPropType.properties.size > 0
    ) {
      converter.currentExpectedType = resolvedPropType;
    }
    const value = converter.visitExpression(prop.initializer);
    converter.currentExpectedType = prevExpected;
    converter.instructions.push(new AssignmentInstruction(propVar, value));
    converter.maybeTrackInlineInstanceAssignment(propVar, value);
  }
}

function emitInlinePropertyInitializersForClass(
  converter: ASTToTACConverter,
  classNode: ClassDeclarationNode,
  state: InlineInitializerState,
): void {
  for (const prop of classNode.properties) {
    if (!prop.initializer || prop.isStatic) continue;
    const previousSerializeFieldState = converter.inSerializeFieldInitializer;
    converter.inSerializeFieldInitializer = !!prop.isSerializeField;
    const propVarName =
      state.kind === "inline"
        ? `${state.instancePrefix}_${prop.name}`
        : getEntryPointPropertyNameForClass(
            converter,
            state.entryClassName,
            prop.name,
          );
    let resolvedPropType = prop.type;
    if (
      prop.initializer.kind === ASTNodeKind.ObjectLiteralExpression &&
      !(resolvedPropType instanceof InterfaceTypeSymbol) &&
      prop.originalTypeName
    ) {
      const lateResolved = converter.typeMapper.mapTypeScriptType(
        prop.originalTypeName,
      );
      if (
        lateResolved instanceof InterfaceTypeSymbol &&
        lateResolved.properties.size > 0
      ) {
        resolvedPropType = lateResolved;
      }
    }
    const propVar = createVariable(propVarName, resolvedPropType);
    const prevExpected = converter.currentExpectedType;
    if (
      prop.initializer.kind === ASTNodeKind.ObjectLiteralExpression &&
      resolvedPropType instanceof InterfaceTypeSymbol &&
      resolvedPropType.properties.size > 0
    ) {
      converter.currentExpectedType = resolvedPropType;
    }
    const value = converter.visitExpression(prop.initializer);
    converter.currentExpectedType = prevExpected;
    converter.inSerializeFieldInitializer = previousSerializeFieldState;
    converter.instructions.push(new AssignmentInstruction(propVar, value));
    converter.maybeTrackInlineInstanceAssignment(propVar, value);
  }
}

export function emitDeferredInlineInitializers(
  converter: ASTToTACConverter,
  className: string,
): void {
  const state = converter.currentInlineInitializerState;
  if (!state || state.emittedClassNames.has(className)) return;
  const classNode =
    state.classNodesByName.get(className) ??
    resolveClassNode(converter, className);
  if (!classNode) return;
  state.classNodesByName.set(className, classNode);
  emitInlinePropertyInitializersForClass(converter, classNode, state);
  state.emittedClassNames.add(className);
}

export function getCurrentDeferredInitializerClassName(
  converter: ASTToTACConverter,
): string | undefined {
  if (converter.currentInlineContext) {
    return converter.currentInlineContext.className;
  }
  if (converter.currentInlineConstructorClassName) {
    return converter.currentInlineConstructorClassName;
  }
  const state = converter.currentInlineInitializerState;
  if (state?.kind === "entry-point") {
    return state.entryClassName;
  }
  return undefined;
}

/**
 * Emit implicit assignments for TypeScript parameter properties
 * (e.g. `constructor(public name: string)` → `this.name = name`).
 *
 * Used by both `visitInlineConstructor` (for the outermost class) and
 * `inlineSuperConstructorFromArgs` (for base classes reached via super()),
 * as well as the super() call handler in `call.ts` (for correct post-super
 * timing in derived classes).
 */
export function emitParamPropertyAssignments(
  converter: ASTToTACConverter,
  className: string,
): void {
  if (!converter.currentInlineContext) return;
  const classNode = resolveClassNode(converter, className);
  if (!classNode?.constructor) return;
  const { instancePrefix } = converter.currentInlineContext;
  for (const param of classNode.constructor.parameters) {
    if (!param.isParameterProperty) continue;
    const fieldVar = converter.mapInlineProperty(
      className,
      instancePrefix,
      param.name,
    );
    if (fieldVar) {
      const paramType = converter.typeMapper.mapTypeScriptType(param.type);
      const paramVar = createVariable(param.name, paramType, {
        isParameter: true,
      });
      converter.emitCopyWithTracking(fieldVar, paramVar);
    }
  }
}

export function inlineSuperConstructorFromArgs(
  converter: ASTToTACConverter,
  baseClassName: string,
  superArgs: TACOperand[],
): void {
  const baseClassNode = resolveClassNode(converter, baseClassName);
  if (!baseClassNode) return;

  const previousInlineContext = converter.currentInlineContext;
  const previousInlineCtorClass = converter.currentInlineConstructorClassName;
  const previousBaseClass = converter.currentInlineBaseClass;
  // NOTE: currentInlineInitializerState is intentionally NOT saved/restored here.
  // It is shared with the outer visitInlineConstructor / emitEntryPointPropertyInit
  // call so that emittedClassNames accumulates across the full super() chain and
  // prevents double-emission of property initializers.
  converter.currentInlineBaseClass = baseClassNode.baseClass ?? undefined;
  converter.currentInlineConstructorClassName = baseClassNode.name;
  // Only update currentInlineContext for inline-instance constructors.
  // Entry-point constructors (currentInlineContext === undefined) use the
  // entry-point property path instead, keyed off currentClassName.
  if (previousInlineContext) {
    converter.currentInlineContext = {
      className: baseClassNode.name,
      instancePrefix: previousInlineContext.instancePrefix,
    };
  }

  try {
    if (baseClassNode.constructor) {
      converter.symbolTable.enterScope();
      const typedParams = baseClassNode.constructor.parameters.map((param) => ({
        name: param.name,
        type: converter.typeMapper.mapTypeScriptType(param.type),
      }));
      const savedParamEntries = saveAndBindInlineParams(
        converter,
        typedParams,
        superArgs,
      );
      try {
        if (!baseClassNode.baseClass) {
          emitDeferredInlineInitializers(converter, baseClassNode.name);
          emitParamPropertyAssignments(converter, baseClassNode.name);
        }
        converter.visitStatement(baseClassNode.constructor.body);
        // Safety-net: if the constructor body contains a super() call, its
        // handler already emitted the deferred initializers (guarded by
        // emittedClassNames). This only does real work when super() was
        // omitted (invalid TypeScript) to avoid silently dropping inits.
        // Param property assignments for derived bases are emitted by the
        // super() call handler in call.ts right after super() returns.
        if (baseClassNode.baseClass) {
          emitDeferredInlineInitializers(converter, baseClassNode.name);
        }
      } finally {
        restoreInlineParams(converter, savedParamEntries);
        converter.symbolTable.exitScope();
      }
      return;
    }

    if (baseClassNode.baseClass) {
      inlineSuperConstructorFromArgs(
        converter,
        baseClassNode.baseClass,
        superArgs,
      );
    }
    emitDeferredInlineInitializers(converter, baseClassNode.name);
  } finally {
    converter.currentInlineContext = previousInlineContext;
    converter.currentInlineConstructorClassName = previousInlineCtorClass;
    converter.currentInlineBaseClass = previousBaseClass;
  }
}

export function visitInlineConstructor(
  this: ASTToTACConverter,
  className: string,
  args: TACOperand[],
): TACOperand {
  if (
    this.inSerializeFieldInitializer &&
    this.udonBehaviourClasses.has(className)
  ) {
    const fallback = this.newTemp(ObjectType);
    this.instructions.push(new CallInstruction(fallback, className, args));
    return fallback;
  }
  if (this.entryPointClasses.has(className)) {
    const fallback = this.newTemp(ObjectType);
    this.instructions.push(new CallInstruction(fallback, className, args));
    return fallback;
  }

  const classNode = resolveClassNode(this, className);
  if (!classNode) {
    const fallback = this.newTemp(ObjectType);
    this.instructions.push(new CallInstruction(fallback, className, args));
    return fallback;
  }

  // Emit static property initializers once per class
  emitStaticPropertyInitializers(this, className);

  // SoA detection: if this constructor runs inside a loop, mark the class
  // so that pass 2 uses DataList-based SoA storage instead of static variables.
  if (this.loopContextStack.length > 0) {
    this.soaClasses.add(className);
  }
  const isSoA = this.soaClasses.has(className);

  // When we're inside an inlined method body, reuse the same prefix+instanceId
  // for the same constructor call position across all invocations of that body.
  // This prevents O(N_call_sites × N_instances) explosion for flyweight classes.
  const { instancePrefix, instanceId } =
    this.allocateBodyCachedInstance(className);

  const instanceHandle = createVariable(
    `${instancePrefix}__handle`,
    PrimitiveTypes.int32,
  );

  if (isSoA) {
    // SoA: lazily create per-field DataLists and counter, then assign
    // handle from the runtime counter (dynamic, not a static constant).
    initSoaForClass(this, className, classNode);
    const counterVar = this.soaCounterVars.get(className);
    if (counterVar) {
      this.instructions.push(new CopyInstruction(instanceHandle, counterVar));
    }
  } else {
    // Non-SoA: handle is a compile-time constant (instanceId).
    // When stored in an interface-typed array (Object[] in Udon), the Int32
    // is CLR-boxed at the Object[] array boundary. The for-of dispatch
    // copies it back to an Int32-typed variable via CopyInstruction, which
    // the CLR runtime unboxes transparently at the typed heap slot.
    this.instructions.push(
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

  // Register classId for interfaces this class implements (including inherited).
  // ClassIds are assigned by visitation order (classIds.size at first encounter).
  // This is non-deterministic across compilation orders but consistent within a
  // single compilation — the for-of dispatch and call-site switch both read from
  // the same interfaceClassIdMap. ClassIds are never serialized or persisted.
  // Invariant: the empty Map created below is always populated in the same
  // synchronous block (classIds.set on the next line), so interfaceClassIdMap
  // never contains an empty Map after this block completes.
  const allInterfaces = this.classRegistry
    ? this.classRegistry.getAllImplementedInterfaces(className)
    : (classNode.implements ?? []);
  for (const ifaceName of allInterfaces) {
    if (!this.interfaceClassIdMap.has(ifaceName)) {
      this.interfaceClassIdMap.set(ifaceName, new Map());
    }
    const classIds = this.interfaceClassIdMap.get(ifaceName);
    if (classIds && !classIds.has(className)) {
      classIds.set(className, classIds.size);
    }
  }

  const inheritanceChain = buildInheritanceChain(this, classNode);

  const previousInitializerState = this.currentInlineInitializerState;
  this.currentInlineInitializerState = {
    kind: "inline",
    entryClassName: undefined,
    instancePrefix,
    classNodesByName: new Map(inheritanceChain.map((cls) => [cls.name, cls])),
    emittedClassNames: new Set(),
  };

  const previousContext = this.currentInlineContext;
  const previousInlineCtorClass = this.currentInlineConstructorClassName;
  const previousThisOverride = this.currentThisOverride;
  const previousBaseClass = this.currentInlineBaseClass;
  this.currentInlineContext = { className, instancePrefix };
  this.currentInlineConstructorClassName = className;
  this.currentThisOverride = null;
  this.currentInlineBaseClass = classNode.baseClass ?? undefined;
  try {
    if (classNode.constructor) {
      this.symbolTable.enterScope();
      const typedParams = classNode.constructor.parameters.map((param) => ({
        name: param.name,
        type: this.typeMapper.mapTypeScriptType(param.type),
      }));
      const savedParamEntries = saveAndBindInlineParams(
        this,
        typedParams,
        args,
      );
      try {
        if (!classNode.baseClass) {
          emitDeferredInlineInitializers(this, classNode.name);
          emitParamPropertyAssignments(this, classNode.name);
        }
        this.visitStatement(classNode.constructor.body);
        // For derived classes: param property assignments are emitted by the
        // super() call handler in call.ts right after super() returns.
        // Deferred initializers use emittedClassNames guard to prevent
        // double-emission; this safety-net handles omitted super().
        if (classNode.baseClass) {
          emitDeferredInlineInitializers(this, classNode.name);
        }
      } finally {
        restoreInlineParams(this, savedParamEntries);
        this.symbolTable.exitScope();
      }
    } else if (classNode.baseClass) {
      inlineSuperConstructorFromArgs(this, classNode.baseClass, args);
      emitDeferredInlineInitializers(this, classNode.name);
    } else {
      emitDeferredInlineInitializers(this, classNode.name);
    }
  } finally {
    this.currentInlineContext = previousContext;
    this.currentInlineConstructorClassName = previousInlineCtorClass;
    this.currentThisOverride = previousThisOverride;
    this.currentInlineBaseClass = previousBaseClass;
    this.currentInlineInitializerState = previousInitializerState;
  }

  // SoA epilogue: snapshot scratch-variable values into per-field DataLists
  // and increment the counter so the next construction gets a fresh index.
  if (isSoA) {
    const fieldLists = this.soaFieldLists.get(className);
    if (fieldLists) {
      for (const [fieldName, listVar] of fieldLists) {
        const scratchVar = this.mapInlineProperty(
          className,
          instancePrefix,
          fieldName,
        );
        if (scratchVar) {
          const token = this.wrapDataToken(scratchVar);
          this.instructions.push(
            new MethodCallInstruction(undefined, listVar, "Add", [token]),
          );
        } else {
          console.warn(
            `transpiler: SoA epilogue for ${className}: mapInlineProperty returned ` +
              `undefined for field "${fieldName}" (prefix ${instancePrefix}). ` +
              `DataList index alignment may be broken.`,
          );
        }
      }
    }
    const counterVar = this.soaCounterVars.get(className);
    if (counterVar) {
      this.instructions.push(
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

export function visitInlineStaticMethodCall(
  this: ASTToTACConverter,
  className: string,
  methodName: string,
  args: TACOperand[],
): TACOperand | null {
  const inlineKey = `${className}.${methodName}`;

  // --- Recursive re-entry: emit JUMP-based self-call ---
  if (this.inlineMethodStack.has(inlineKey)) {
    const ctx = this.currentInlineRecursiveContext;
    if (ctx && ctx.className === className && ctx.methodName === methodName) {
      return emitInlineRecursiveSelfCall(this, ctx, args);
    }
    // No matching recursive context — this can happen for non-recursive
    // methods that are already being inlined (mutual recursion, or a
    // method calling itself without countStaticSelfCalls detecting it).
    console.warn(
      `transpiler: recursive re-entry for ${className}.${methodName} but no matching inline recursive context — falling through to extern.`,
    );
    return null;
  }

  // Walk inheritance chain to find the static method (may be on a base class).
  const resolved = resolveClassMethod(this, className, methodName, true);
  if (!resolved) return null;
  const method = resolved.method;

  let returnType: TypeSymbol = method.returnType;
  if (
    !(returnType instanceof InterfaceTypeSymbol) &&
    method.originalReturnTypeName
  ) {
    const lateResolved = this.typeMapper.mapTypeScriptType(
      method.originalReturnTypeName,
    );
    if (
      lateResolved instanceof InterfaceTypeSymbol &&
      lateResolved.properties.size > 0
    ) {
      returnType = lateResolved;
    }
  }

  // --- Check for self-recursion ---
  const selfCallCount = countStaticSelfCalls(
    className,
    methodName,
    method.body,
  );
  if (selfCallCount > 0) {
    return emitInlineRecursiveStaticMethod(
      this,
      className,
      methodName,
      method,
      returnType,
      args,
      selfCallCount,
      inlineKey,
    );
  }

  // --- Non-recursive path (unchanged) ---
  const result = createVariable(
    `__inline_ret_${this.tempCounter++}`,
    returnType,
    { isLocal: true },
  );
  const returnLabel = this.newLabel("inline_return");

  this.symbolTable.enterScope();
  const savedParamEntries = saveAndBindInlineParams(
    this,
    method.parameters,
    args,
  );

  const savedParamExportMap = this.currentParamExportMap;
  const savedParamExportReverseMap = this.currentParamExportReverseMap;
  const savedMethodLayout = this.currentMethodLayout;
  const savedInlineContext = this.currentInlineContext;
  const savedInlineCtorClass = this.currentInlineConstructorClassName;
  const savedThisOverride = this.currentThisOverride;
  const savedBaseClass = this.currentInlineBaseClass;
  this.currentParamExportMap = new Map();
  this.currentParamExportReverseMap = new Map();
  this.currentMethodLayout = null;
  this.currentInlineContext = undefined;
  this.currentInlineConstructorClassName = undefined;
  this.currentThisOverride = null;
  this.currentInlineBaseClass = undefined;

  this.inlineMethodStack.add(inlineKey);
  // Only apply the stable-prefix strategy for interface return types.
  // For concrete ClassTypeSymbol returns, direct tracking is preserved so
  // that property writes (e.g. compound assignments) reach the original
  // inline instance fields rather than a one-shot copy.
  const returnInstancePrefix =
    returnType instanceof InterfaceTypeSymbol && returnType.properties.size > 0
      ? result.name
      : undefined;
  this.inlineReturnStack.push({
    returnVar: result,
    returnLabel,
    returnTrackingInvalidated: false,
    loopDepth: this.loopContextStack.length,
    returnInstancePrefix,
  });
  // Reset constructor index for this body so deduplication picks up from
  // position 0 on each invocation (cache may already be populated from a
  // prior call to the same body).
  this.methodBodyConstructorIndex.set(method.body, 0);
  this.inlinedBodyStack.push(method.body);
  const savedInlineNativeIneligible = this.nativeArrayIneligible;
  const savedInlineNativeVarName = this.currentNativeArrayVarName;
  this.nativeArrayIneligible = analyzeNativeArrayIneligibility(
    method.body.statements,
  );
  this.currentNativeArrayVarName = null;
  try {
    this.visitBlockStatement(method.body);
  } finally {
    this.nativeArrayIneligible = savedInlineNativeIneligible;
    this.currentNativeArrayVarName = savedInlineNativeVarName;
    this.inlinedBodyStack.pop();
    this.inlineReturnStack.pop();
    this.inlineMethodStack.delete(inlineKey);
    this.currentParamExportMap = savedParamExportMap;
    this.currentParamExportReverseMap = savedParamExportReverseMap;
    this.currentMethodLayout = savedMethodLayout;
    this.currentInlineContext = savedInlineContext;
    this.currentInlineConstructorClassName = savedInlineCtorClass;
    this.currentThisOverride = savedThisOverride;
    this.currentInlineBaseClass = savedBaseClass;
    restoreInlineParams(this, savedParamEntries);
    this.symbolTable.exitScope();
  }

  this.instructions.push(new LabelInstruction(returnLabel));
  return result;
}

/**
 * Emit the full body of a recursive inline static method with JUMP-based
 * call/return infrastructure. Called once per unique recursive static method
 * (on first invocation). Uses the same pattern as @RecursiveMethod:
 * DataList stacks for locals, depth counter, SP, return-site dispatch table.
 */
function emitInlineRecursiveStaticMethod(
  converter: ASTToTACConverter,
  className: string,
  methodName: string,
  method: {
    parameters: Array<{ name: string; type: TypeSymbol }>;
    body: BlockStatementNode;
    returnType: TypeSymbol;
    originalReturnTypeName?: string;
  },
  returnType: TypeSymbol,
  args: TACOperand[],
  selfCallCount: number,
  inlineKey: string,
): TACOperand {
  const prefix = `__inlineRec_${className}_${methodName}`;
  const depthVar = `${prefix}_depth`;
  const spVar = `${prefix}_sp`;
  const returnSiteIdxVarName = `${prefix}_returnSiteIdx`;

  // Collect locals (parameters + declared variables)
  const locals = collectRecursiveLocals.call(converter, method);
  // Add return site index
  locals.push({ name: returnSiteIdxVarName, type: PrimitiveTypes.int32 });
  // Add self-call result variables
  for (let i = 0; i < selfCallCount; i++) {
    locals.push({
      name: `${prefix}_selfCallResult_${i}`,
      type: returnType,
    });
  }
  // Add synthesized try/catch error flag/value variables so they survive
  // across recursive self-call boundaries (same pattern as @RecursiveMethod).
  // Capture the starting tryCounter now; body traversal will consume these
  // IDs sequentially. No reservation (tryCounter +=) is needed here because
  // visitBlockStatement will advance tryCounter as it encounters each
  // try/catch — the IDs will match by construction.
  const tryCatchCount = countTryCatchBlocks(method.body);
  const startTryId = converter.tryCounter;
  for (let i = 0; i < tryCatchCount; i++) {
    const tryId = startTryId + i;
    locals.push({
      name: `__error_flag_${tryId}`,
      type: PrimitiveTypes.boolean,
    });
    locals.push({ name: `__error_value_${tryId}`, type: ObjectType });
  }

  const stackVars = locals.map((local) => ({
    name: `${prefix}_stack_${local.name}`,
    type: ExternTypes.dataList as TypeSymbol,
  }));

  const result = createVariable(
    `${prefix}_retVal_${converter.tempCounter++}`,
    returnType,
    { isLocal: true },
  );
  const entryLabel = converter.newLabel("inline_rec_entry");
  const dispatchLabel = converter.newLabel("inline_rec_dispatch");
  const overflowLabel = converter.newLabel("inline_rec_overflow");
  const doneLabel = converter.newLabel("inline_rec_done");

  // --- Initial call: set up params with inline tracking ---
  converter.symbolTable.enterScope();
  const savedInitialParams = saveAndBindInlineParams(
    converter,
    method.parameters,
    args,
  );
  // Set initial return site index to 0 (sentinel: initial caller)
  const returnSiteIdxVar = createVariable(
    returnSiteIdxVarName,
    PrimitiveTypes.int32,
    { isLocal: true },
  );
  converter.instructions.push(
    new AssignmentInstruction(
      returnSiteIdxVar,
      createConstant(0, PrimitiveTypes.int32),
    ),
  );

  // --- Prologue: stack allocation (once) ---
  const stackInitFlagName = `${prefix}_stackInit`;
  const stackInitFlag = createVariable(
    stackInitFlagName,
    PrimitiveTypes.boolean,
  );
  const notInitialized = converter.newTemp(PrimitiveTypes.boolean);
  converter.instructions.push(
    new BinaryOpInstruction(
      notInitialized,
      stackInitFlag,
      "==",
      createConstant(false, PrimitiveTypes.boolean),
    ),
  );
  const skipAllocLabel = converter.newLabel("inline_rec_skip_alloc");
  converter.instructions.push(
    new ConditionalJumpInstruction(notInitialized, skipAllocLabel),
  );
  {
    converter.emitCopyWithTracking(
      stackInitFlag,
      createConstant(true, PrimitiveTypes.boolean),
    );
    const defaultToken = converter.wrapDataToken(
      createConstant(0, PrimitiveTypes.single),
    );
    for (const stackVarInfo of stackVars) {
      const stackVar = createVariable(stackVarInfo.name, ExternTypes.dataList);
      const externSig = converter.requireExternSignature(
        "DataList",
        "ctor",
        "method",
        [],
        "DataList",
      );
      converter.instructions.push(new CallInstruction(stackVar, externSig, []));
      for (let i = 0; i < MAX_RECURSION_STACK_DEPTH; i++) {
        converter.instructions.push(
          new MethodCallInstruction(undefined, stackVar, "Add", [defaultToken]),
        );
      }
    }
  }
  converter.instructions.push(new LabelInstruction(skipAllocLabel));

  // Reset SP when at top level
  {
    const depthVarOp = createVariable(depthVar, PrimitiveTypes.int32);
    const depthAtTopLevel = converter.newTemp(PrimitiveTypes.boolean);
    converter.instructions.push(
      new BinaryOpInstruction(
        depthAtTopLevel,
        depthVarOp,
        "<=",
        createConstant(0, PrimitiveTypes.int32),
      ),
    );
    const skipSpResetLabel = converter.newLabel("inline_rec_skip_sp_reset");
    converter.instructions.push(
      new ConditionalJumpInstruction(depthAtTopLevel, skipSpResetLabel),
    );
    const spVarOp = createVariable(spVar, PrimitiveTypes.int32);
    converter.emitCopyWithTracking(
      spVarOp,
      createConstant(-1, PrimitiveTypes.int32),
    );
    converter.emitCopyWithTracking(
      depthVarOp,
      createConstant(0, PrimitiveTypes.int32),
    );
    converter.instructions.push(new LabelInstruction(skipSpResetLabel));
  }

  // Overflow handler
  {
    const afterOverflowLabel = converter.newLabel("inline_rec_after_overflow");
    converter.instructions.push(
      new UnconditionalJumpInstruction(afterOverflowLabel),
    );
    converter.instructions.push(new LabelInstruction(overflowLabel));
    const logErrorExtern = converter.requireExternSignature(
      "Debug",
      "LogError",
      "method",
      ["object"],
      "void",
    );
    const overflowMsg = createConstant(
      `[udon-assembly-ts] Max recursion depth (${MAX_RECURSION_STACK_DEPTH}) exceeded in ${className}.${methodName}.`,
      PrimitiveTypes.string,
    );
    converter.instructions.push(
      new CallInstruction(undefined, logErrorExtern, [overflowMsg]),
    );
    // Reset depth and SP so subsequent invocations can re-enter cleanly.
    converter.emitCopyWithTracking(
      createVariable(depthVar, PrimitiveTypes.int32),
      createConstant(0, PrimitiveTypes.int32),
    );
    // SP = -1 (empty-stack sentinel, consistent with top-level entry reset)
    converter.emitCopyWithTracking(
      createVariable(spVar, PrimitiveTypes.int32),
      createConstant(-1, PrimitiveTypes.int32),
    );
    // Jump to done (return default value) instead of ReturnInstruction
    // because we're inside an inlined method, not a top-level method.
    converter.instructions.push(new UnconditionalJumpInstruction(doneLabel));
    converter.instructions.push(new LabelInstruction(afterOverflowLabel));
  }

  // --- Entry label (JUMP target for recursive calls) ---
  converter.instructions.push(new LabelInstruction(entryLabel));

  // Set up inline recursive context
  const ctx: NonNullable<typeof converter.currentInlineRecursiveContext> = {
    className,
    methodName,
    locals,
    depthVar,
    spVar,
    stackVars,
    returnSites: [],
    // Start at 1: index 0 is reserved as sentinel for the initial
    // (non-recursive) caller. The dispatch table only contains sites
    // 1, 2, … and falls through to doneLabel for index 0.
    nextReturnSiteIndex: 1,
    nextSelfCallResultIndex: 0,
    entryLabel,
    dispatchLabel,
    overflowLabel,
    returnVar: result,
  };

  const savedInlineRecCtx = converter.currentInlineRecursiveContext;
  converter.currentInlineRecursiveContext = ctx;

  // Standard inline method setup — scope + params already set up via
  // saveAndBindInlineParams in the initial-call path above.
  const savedParamExportMap = converter.currentParamExportMap;
  const savedParamExportReverseMap = converter.currentParamExportReverseMap;
  const savedMethodLayout = converter.currentMethodLayout;
  const savedInlineContext = converter.currentInlineContext;
  const savedInlineCtorClass = converter.currentInlineConstructorClassName;
  const savedThisOverride = converter.currentThisOverride;
  const savedBaseClass = converter.currentInlineBaseClass;
  converter.currentParamExportMap = new Map();
  converter.currentParamExportReverseMap = new Map();
  converter.currentMethodLayout = null;
  converter.currentInlineContext = undefined;
  converter.currentInlineConstructorClassName = undefined;
  converter.currentThisOverride = null;
  converter.currentInlineBaseClass = undefined;

  converter.inlineMethodStack.add(inlineKey);
  converter.inlineReturnStack.push({
    returnVar: result,
    returnLabel: dispatchLabel, // returns jump to dispatch, not a simple label
    returnTrackingInvalidated: false,
    loopDepth: converter.loopContextStack.length,
    returnInstancePrefix: undefined,
  });
  converter.methodBodyConstructorIndex.set(method.body, 0);
  converter.inlinedBodyStack.push(method.body);
  const savedRecNativeIneligible = converter.nativeArrayIneligible;
  const savedRecNativeVarName = converter.currentNativeArrayVarName;
  converter.nativeArrayIneligible = analyzeNativeArrayIneligibility(
    method.body.statements,
  );
  converter.currentNativeArrayVarName = null;

  try {
    converter.visitBlockStatement(method.body);
  } finally {
    converter.nativeArrayIneligible = savedRecNativeIneligible;
    converter.currentNativeArrayVarName = savedRecNativeVarName;
    converter.inlinedBodyStack.pop();
    converter.inlineReturnStack.pop();
    converter.inlineMethodStack.delete(inlineKey);
    converter.currentParamExportMap = savedParamExportMap;
    converter.currentParamExportReverseMap = savedParamExportReverseMap;
    converter.currentMethodLayout = savedMethodLayout;
    converter.currentInlineContext = savedInlineContext;
    converter.currentInlineConstructorClassName = savedInlineCtorClass;
    converter.currentThisOverride = savedThisOverride;
    converter.currentInlineBaseClass = savedBaseClass;
    restoreInlineParams(converter, savedInitialParams);
    converter.symbolTable.exitScope();
    converter.currentInlineRecursiveContext = savedInlineRecCtx;
  }

  // Fallthrough at end of body: decrement depth and jump to dispatch
  {
    const depthVarOp = createVariable(depthVar, PrimitiveTypes.int32);
    const depthTmp = converter.newTemp(PrimitiveTypes.int32);
    converter.instructions.push(
      new BinaryOpInstruction(
        depthTmp,
        depthVarOp,
        "-",
        createConstant(1, PrimitiveTypes.int32),
      ),
    );
    converter.emitCopyWithTracking(depthVarOp, depthTmp);
    converter.instructions.push(
      new UnconditionalJumpInstruction(dispatchLabel),
    );
  }

  // --- Return site dispatch table ---
  converter.instructions.push(new LabelInstruction(dispatchLabel));
  {
    const returnSiteIdxVarOp = createVariable(
      returnSiteIdxVarName,
      PrimitiveTypes.int32,
      { isLocal: true },
    );
    for (const site of ctx.returnSites) {
      const cmpResult = converter.newTemp(PrimitiveTypes.boolean);
      converter.instructions.push(
        new BinaryOpInstruction(
          cmpResult,
          returnSiteIdxVarOp,
          "!=",
          createConstant(site.index, PrimitiveTypes.int32),
        ),
      );
      const siteLabel = createLabel(site.labelName);
      converter.instructions.push(
        new ConditionalJumpInstruction(cmpResult, siteLabel),
      );
    }
    // Fallback: index 0 (initial caller) — jump to done
    converter.instructions.push(new UnconditionalJumpInstruction(doneLabel));
  }

  converter.instructions.push(new LabelInstruction(doneLabel));
  return result;
}

/**
 * Emit a JUMP-based self-call for a recursive inline static method.
 * Called when the recursion guard fires inside visitInlineStaticMethodCall.
 */
function emitInlineRecursiveSelfCall(
  converter: ASTToTACConverter,
  ctx: NonNullable<typeof converter.currentInlineRecursiveContext>,
  args: TACOperand[],
): TACOperand {
  // 0. Save inlineInstanceMap state so the caller's tracking is restored
  //    after the recursive call (push/pop only covers runtime locals, not
  //    the compile-time inline tracking map).
  const savedInstanceMap = new Map(converter.inlineInstanceMap);

  // 1. Push all locals to stack (save caller's current state)
  emitInlineRecursivePush.call(converter);

  // 2. Increment depth
  const depthVarOp = createVariable(ctx.depthVar, PrimitiveTypes.int32);
  const depthInc = converter.newTemp(PrimitiveTypes.int32);
  converter.instructions.push(
    new BinaryOpInstruction(
      depthInc,
      depthVarOp,
      "+",
      createConstant(1, PrimitiveTypes.int32),
    ),
  );
  converter.emitCopyWithTracking(depthVarOp, depthInc);

  // 3. Set parameters for the callee (find param names from the method)
  const classNode = resolveClassNode(converter, ctx.className);
  if (!classNode) {
    throw new Error(
      `emitInlineRecursiveSelfCall: class '${ctx.className}' not found`,
    );
  }
  const method = classNode.methods.find(
    (m) => m.name === ctx.methodName && m.isStatic,
  );
  if (!method) {
    throw new Error(
      `emitInlineRecursiveSelfCall: static method '${ctx.className}.${ctx.methodName}' not found`,
    );
  }
  for (let i = 0; i < method.parameters.length; i++) {
    const param = method.parameters[i];
    const paramVar = createVariable(param.name, param.type, {
      isLocal: true,
    });
    if (args[i] !== undefined) {
      converter.emitCopyWithTracking(paramVar, args[i]);
    }
  }

  // 4. Set return site index
  const returnLabel = converter.newLabel("inline_rec_return") as LabelOperand;
  const returnSiteIdx = ctx.nextReturnSiteIndex++;
  ctx.returnSites.push({
    index: returnSiteIdx,
    labelName: returnLabel.name,
  });
  const prefix = `__inlineRec_${ctx.className}_${ctx.methodName}`;
  const returnSiteIdxVar = createVariable(
    `${prefix}_returnSiteIdx`,
    PrimitiveTypes.int32,
    { isLocal: true },
  );
  converter.instructions.push(
    new AssignmentInstruction(
      returnSiteIdxVar,
      createConstant(returnSiteIdx, PrimitiveTypes.int32),
    ),
  );

  // 5. JUMP to method entry
  converter.instructions.push(new UnconditionalJumpInstruction(ctx.entryLabel));

  // 6. Return label (dispatch brings us back here)
  converter.instructions.push(new LabelInstruction(returnLabel));

  // 7. Read return value into temp BEFORE pop
  const capturedTemp = converter.newTemp(
    converter.getOperandType(ctx.returnVar),
  );
  converter.emitCopyWithTracking(capturedTemp, ctx.returnVar);

  // 8. Pop all locals from stack (restore caller's state)
  emitInlineRecursivePop.call(converter);

  // 8b. Restore compile-time inlineInstanceMap to caller's state
  converter.inlineInstanceMap.clear();
  for (const [k, v] of savedInstanceMap) {
    converter.inlineInstanceMap.set(k, v);
  }

  // 9. Copy captured result into a named selfCallResult variable
  //    that is part of the push/pop set (survives sibling calls)
  const selfCallIdx = ctx.nextSelfCallResultIndex;
  ctx.nextSelfCallResultIndex = selfCallIdx + 1;
  const selfCallResultVar = createVariable(
    `${prefix}_selfCallResult_${selfCallIdx}`,
    converter.getOperandType(ctx.returnVar),
    { isLocal: true },
  );
  converter.emitCopyWithTracking(selfCallResultVar, capturedTemp);
  return selfCallResultVar;
}

/**
 * Shared implementation for instance method inlining.
 * When instancePrefix is provided, sets currentInlineContext;
 * otherwise clears it.
 */
function inlineInstanceMethodCallCore(
  converter: ASTToTACConverter,
  className: string,
  methodName: string,
  args: TACOperand[],
  instancePrefix: string | undefined,
): TACOperand | null {
  const inlineKey = `${className}::${methodName}`;
  if (converter.inlineMethodStack.has(inlineKey)) {
    return null; // recursion detected → fallback
  }
  // Walk inheritance chain to find the method (may be on a base class).
  const resolved = resolveClassMethod(converter, className, methodName, false);
  if (!resolved) return null;
  const method = resolved.method;

  let returnType: TypeSymbol = method.returnType;
  if (
    !(returnType instanceof InterfaceTypeSymbol) &&
    method.originalReturnTypeName
  ) {
    const lateResolved = converter.typeMapper.mapTypeScriptType(
      method.originalReturnTypeName,
    );
    if (
      lateResolved instanceof InterfaceTypeSymbol &&
      lateResolved.properties.size > 0
    ) {
      returnType = lateResolved;
    }
  }
  const result = createVariable(
    `__inline_ret_${converter.tempCounter++}`,
    returnType,
    { isLocal: true },
  );
  const returnLabel = converter.newLabel("inline_return");

  converter.symbolTable.enterScope();
  const savedParamEntries = saveAndBindInlineParams(
    converter,
    method.parameters,
    args,
  );

  const savedParamExportMap = converter.currentParamExportMap;
  const savedParamExportReverseMap = converter.currentParamExportReverseMap;
  const savedMethodLayout = converter.currentMethodLayout;
  const savedInlineContext = converter.currentInlineContext;
  const savedInlineCtorClass = converter.currentInlineConstructorClassName;
  const savedThisOverride = converter.currentThisOverride;
  const savedBaseClass = converter.currentInlineBaseClass;
  converter.currentParamExportMap = new Map();
  converter.currentParamExportReverseMap = new Map();
  converter.currentMethodLayout = null;
  converter.currentInlineConstructorClassName = undefined;
  converter.currentThisOverride = null;
  converter.currentInlineBaseClass = undefined;
  converter.currentInlineContext = instancePrefix
    ? { className, instancePrefix }
    : undefined;

  converter.inlineMethodStack.add(inlineKey);
  // Only apply the stable-prefix strategy for interface return types.
  // For concrete ClassTypeSymbol returns, direct tracking is preserved so
  // that property writes (e.g. compound assignments) reach the original
  // inline instance fields rather than a one-shot copy.
  const returnInstancePrefix =
    returnType instanceof InterfaceTypeSymbol && returnType.properties.size > 0
      ? result.name
      : undefined;
  converter.inlineReturnStack.push({
    returnVar: result,
    returnLabel,
    returnTrackingInvalidated: false,
    loopDepth: converter.loopContextStack.length,
    returnInstancePrefix,
  });
  // Reset constructor index for this body so deduplication picks up from
  // position 0 on each invocation (cache may already be populated).
  converter.methodBodyConstructorIndex.set(method.body, 0);
  converter.inlinedBodyStack.push(method.body);
  const savedInstNativeIneligible = converter.nativeArrayIneligible;
  const savedInstNativeVarName = converter.currentNativeArrayVarName;
  converter.nativeArrayIneligible = analyzeNativeArrayIneligibility(
    method.body.statements,
  );
  converter.currentNativeArrayVarName = null;
  try {
    converter.visitBlockStatement(method.body);
  } finally {
    converter.nativeArrayIneligible = savedInstNativeIneligible;
    converter.currentNativeArrayVarName = savedInstNativeVarName;
    converter.inlinedBodyStack.pop();
    converter.inlineReturnStack.pop();
    converter.inlineMethodStack.delete(inlineKey);
    converter.currentParamExportMap = savedParamExportMap;
    converter.currentParamExportReverseMap = savedParamExportReverseMap;
    converter.currentMethodLayout = savedMethodLayout;
    converter.currentInlineContext = savedInlineContext;
    converter.currentInlineConstructorClassName = savedInlineCtorClass;
    converter.currentThisOverride = savedThisOverride;
    converter.currentInlineBaseClass = savedBaseClass;
    restoreInlineParams(converter, savedParamEntries);
    converter.symbolTable.exitScope();
  }

  converter.instructions.push(new LabelInstruction(returnLabel));
  return result;
}

export function visitInlineInstanceMethodCall(
  this: ASTToTACConverter,
  className: string,
  methodName: string,
  args: TACOperand[],
): TACOperand | null {
  return inlineInstanceMethodCallCore(
    this,
    className,
    methodName,
    args,
    undefined,
  );
}

export function visitInlineInstanceMethodCallWithContext(
  this: ASTToTACConverter,
  className: string,
  instancePrefix: string,
  methodName: string,
  args: TACOperand[],
): TACOperand | null {
  return inlineInstanceMethodCallCore(
    this,
    className,
    methodName,
    args,
    instancePrefix,
  );
}

/**
 * Emit property initializers and constructor body for an entry-point class.
 * Shared by visitClassDeclaration (Start method path) and generateEntryPoint (no-Start path).
 */
export function emitEntryPointPropertyInit(
  this: ASTToTACConverter,
  classNode: ClassDeclarationNode,
): void {
  // Emit static property initializers for the entry-point class
  emitStaticPropertyInitializers(this, classNode.name);
  // Eagerly emit static initializers for all known inline classes to
  // avoid placement inside conditional branches on first lazy access.
  if (this.classRegistry) {
    for (const cls of this.classRegistry.getAllClasses()) {
      if (
        !this.udonBehaviourClasses.has(cls.name) &&
        !this.entryPointClasses.has(cls.name) &&
        cls.node.properties.some((p) => p.isStatic && p.initializer)
      ) {
        emitStaticPropertyInitializers(this, cls.name);
      }
    }
  }
  const inheritanceChain = buildInheritanceChain(this, classNode);
  const previousInitializerState = this.currentInlineInitializerState;
  this.currentInlineInitializerState = {
    kind: "entry-point",
    entryClassName: classNode.name,
    instancePrefix: undefined,
    classNodesByName: new Map(inheritanceChain.map((cls) => [cls.name, cls])),
    emittedClassNames: new Set(),
  };
  try {
    if (classNode.constructor?.body) {
      const nonSerializeFieldParams = classNode.constructor.parameters.filter(
        (p) => !p.isSerializeField,
      );
      if (nonSerializeFieldParams.length > 0) {
        throw new Error(
          `Entry-point class "${classNode.name}" constructor must be parameterless`,
        );
      }
      this.symbolTable.enterScope();
      const previousInlineCtorClass = this.currentInlineConstructorClassName;
      const previousBaseClass = this.currentInlineBaseClass;
      this.currentInlineConstructorClassName = classNode.name;
      this.currentInlineBaseClass = classNode.baseClass ?? undefined;
      try {
        if (!classNode.baseClass) {
          emitDeferredInlineInitializers(this, classNode.name);
        }
        // Register @SerializeField params so the constructor body can reference them
        for (const param of classNode.constructor.parameters) {
          if (!param.isSerializeField) continue;
          const paramType = this.typeMapper.mapTypeScriptType(param.type);
          this.symbolTable.addSymbol(param.name, paramType, true, false);
        }
        this.visitStatement(classNode.constructor.body);
        if (classNode.baseClass) {
          emitDeferredInlineInitializers(this, classNode.name);
        }
      } finally {
        this.currentInlineConstructorClassName = previousInlineCtorClass;
        this.currentInlineBaseClass = previousBaseClass;
        this.symbolTable.exitScope();
      }
    } else if (classNode.baseClass) {
      inlineSuperConstructorFromArgs(this, classNode.baseClass, []);
      emitDeferredInlineInitializers(this, classNode.name);
    } else {
      emitDeferredInlineInitializers(this, classNode.name);
    }
  } finally {
    this.currentInlineInitializerState = previousInitializerState;
  }
}

/**
 * Extract the inlineInstanceMap key for an operand, or undefined if the
 * operand kind does not participate in tracking (Constants, Labels).
 */
// Keys share the inlineInstanceMap namespace. The __tmp prefix is assumed
// not to collide with user variable names; a collision would only degrade
// tracking (EXTERN fallback), not produce incorrect code.
export function operandTrackingKey(op: TACOperand): string | undefined {
  if (op.kind === TACOperandKind.Variable) return (op as VariableOperand).name;
  if (op.kind === TACOperandKind.Temporary)
    return `__tmp${(op as TemporaryOperand).id}`;
  return undefined;
}

/**
 * Allocate (or reuse) an instance prefix and instanceId for a new inline instance,
 * deduplicating across repeated inlinings of the same method body via
 * `methodBodyInstanceCache` / `methodBodyConstructorIndex`.
 */
export function allocateBodyCachedInstance(
  this: ASTToTACConverter,
  className: string,
): { instancePrefix: string; instanceId: number } {
  const currentBody = this.inlinedBodyStack[this.inlinedBodyStack.length - 1];
  if (currentBody !== undefined) {
    let cache = this.methodBodyInstanceCache.get(currentBody);
    const idx = this.methodBodyConstructorIndex.get(currentBody) ?? 0;
    if (cache !== undefined && idx < cache.length) {
      const cached = cache[idx];
      this.methodBodyConstructorIndex.set(currentBody, idx + 1);
      return { instancePrefix: cached.prefix, instanceId: cached.instanceId };
    }
    const instancePrefix = `__inst_${className}_${this.instanceCounter++}`;
    const instanceId = this.nextInstanceId++;
    if (cache === undefined) {
      cache = [];
      this.methodBodyInstanceCache.set(currentBody, cache);
    }
    cache.push({ prefix: instancePrefix, instanceId });
    this.methodBodyConstructorIndex.set(currentBody, idx + 1);
    return { instancePrefix, instanceId };
  }
  return {
    instancePrefix: `__inst_${className}_${this.instanceCounter++}`,
    instanceId: this.nextInstanceId++,
  };
}

/**
 * Update inline-instance tracking after an AssignmentInstruction.
 *
 * Sets `target`'s mapping when `value` resolves to an inline instance.
 * When `value` is not a tracked inline instance:
 *   - `clearIfUntracked=true` (default): clears any existing mapping for `target`.
 *   - `clearIfUntracked=false`: preserves any existing mapping for `target`.
 *
 * Use `clearIfUntracked=false` for variable declarations where the target may
 * carry pre-existing tracking from an outer scope (e.g. a local variable that
 * shadows a same-named parameter). Clearing in those cases would break inline
 * field access even though the runtime object identity is unchanged.
 *
 * NOTE: Unlike `emitCopyWithTracking`, this does not emit an instruction —
 * call it after manually emitting an AssignmentInstruction.
 */
export function maybeTrackInlineInstanceAssignment(
  this: ASTToTACConverter,
  target: VariableOperand,
  value: TACOperand,
  clearIfUntracked = true,
): void {
  const srcName = operandTrackingKey(value);
  const mapped = srcName ? this.resolveInlineInstance(srcName) : undefined;
  if (mapped) {
    this.inlineInstanceMap.set(target.name, mapped);
  } else if (clearIfUntracked) {
    this.inlineInstanceMap.delete(target.name);
  }
}

/**
 * Emit a CopyInstruction and propagate inline instance tracking from src to dest.
 *
 * Uses `resolveInlineInstance` (3-step lookup: direct → forward → reverse)
 * so that tracking survives multi-hop copy chains (return values, parameters,
 * intermediate variables). Handles both Variable and Temporary operands.
 * Clears stale tracking on dest when src is not an inline instance (unless
 * clearIfUntracked=false, which preserves existing tracking on dest).
 */
export function emitCopyWithTracking(
  this: ASTToTACConverter,
  dest: TACOperand,
  src: TACOperand,
  clearIfUntracked = true,
): void {
  this.instructions.push(new CopyInstruction(dest, src));
  const destName = operandTrackingKey(dest);
  if (!destName) return;
  const srcName = operandTrackingKey(src);
  const srcInfo = srcName ? this.resolveInlineInstance(srcName) : undefined;
  if (srcInfo) {
    this.inlineInstanceMap.set(destName, srcInfo);
  } else if (clearIfUntracked) {
    this.inlineInstanceMap.delete(destName);
  }
}

/**
 * Look up inline instance info by variable name, bridging raw ↔ export names.
 *
 * Tries three lookups in order:
 * 1. Direct: `inlineInstanceMap.get(name)`
 * 2. Forward: name is a raw param → look up its export name
 * 3. Reverse: name is an export name → find the corresponding raw param name
 *
 * Reverse lookup uses currentParamExportReverseMap for O(1) export → raw lookup.
 */
export function resolveInlineInstance(
  this: ASTToTACConverter,
  name: string,
): { prefix: string; className: string } | undefined {
  const direct = this.inlineInstanceMap.get(name);
  if (direct) return direct;
  const exportName = this.currentParamExportMap.get(name);
  if (exportName) {
    const byExport = this.inlineInstanceMap.get(exportName);
    if (byExport) return byExport;
  }
  const rawName = this.currentParamExportReverseMap.get(name);
  if (rawName) {
    return this.inlineInstanceMap.get(rawName);
  }
  return undefined;
}

export function mapInlineProperty(
  this: ASTToTACConverter,
  className: string,
  instancePrefix: string,
  property: string,
): VariableOperand | undefined {
  const resolved = resolveClassProperty(this, className, property);
  if (resolved) {
    return createVariable(`${instancePrefix}_${property}`, resolved.prop.type);
  }

  // Fallback: InterfaceTypeSymbol from type alias
  const alias = this.typeMapper.getAlias(className);
  if (alias instanceof InterfaceTypeSymbol) {
    const rawPropType = alias.properties.get(property);
    if (rawPropType) {
      // Re-resolve through typeMapper: if the property type was a stale alias
      // (e.g. Wind was parsed before its definition was registered), look up
      // its name now that all files have been parsed.
      const resolvedPropType = rawPropType.name
        ? (this.typeMapper.getAlias(rawPropType.name) ?? rawPropType)
        : rawPropType;
      return createVariable(`${instancePrefix}_${property}`, resolvedPropType);
    }
  }

  // Fallback: InterfaceMetadata from classRegistry
  if (this.classRegistry) {
    const iface = this.classRegistry.getInterface(className);
    if (iface) {
      const ifaceProp = iface.properties.find((p) => p.name === property);
      if (ifaceProp)
        return createVariable(
          `${instancePrefix}_${property}`,
          this.typeMapper.mapTypeScriptType(ifaceProp.type),
        );
    }
  }
  return undefined;
}

/**
 * Resolve the concrete class name for an inline instance.
 * When className is an interface/type alias (not a concrete class),
 * search allInlineInstances to find the actual implementing class
 * that owns the given prefix.
 */
export function resolveConcreteClassName(
  converter: ASTToTACConverter,
  instanceInfo: { prefix: string; className: string },
): string {
  if (resolveClassNode(converter, instanceInfo.className)) {
    return instanceInfo.className;
  }
  for (const [, info] of converter.allInlineInstances) {
    if (
      info.prefix === instanceInfo.prefix &&
      resolveClassNode(converter, info.className)
    ) {
      return info.className;
    }
  }
  return instanceInfo.className;
}

export function tryResolveUnitySelfReference(
  this: ASTToTACConverter,
  node: PropertyAccessExpressionNode,
): VariableOperand | null {
  if (node.object.kind !== ASTNodeKind.ThisExpression) return null;
  if (node.property === "gameObject") {
    return createVariable("__gameObject", ExternTypes.gameObject);
  }
  if (node.property === "transform") {
    return createVariable("__transform", ExternTypes.transform);
  }
  return null;
}

export function collectRecursiveLocals(
  this: ASTToTACConverter,
  method: {
    parameters: Array<{ name: string; type: TypeSymbol }>;
    body: BlockStatementNode;
  },
): Array<{ name: string; type: TypeSymbol }> {
  const locals = new Map<string, TypeSymbol>();
  for (const param of method.parameters) {
    locals.set(param.name, param.type);
  }

  const visitNode = (node: ASTNode): void => {
    switch (node.kind) {
      case ASTNodeKind.VariableDeclaration: {
        const varNode = node as VariableDeclarationNode;
        locals.set(varNode.name, varNode.type);
        if (varNode.initializer) visitNode(varNode.initializer);
        break;
      }
      case ASTNodeKind.BlockStatement: {
        const block = node as BlockStatementNode;
        for (const stmt of block.statements) visitNode(stmt);
        break;
      }
      case ASTNodeKind.IfStatement: {
        const ifNode = node as IfStatementNode;
        visitNode(ifNode.condition);
        visitNode(ifNode.thenBranch);
        if (ifNode.elseBranch) visitNode(ifNode.elseBranch);
        break;
      }
      case ASTNodeKind.WhileStatement: {
        const whileNode = node as WhileStatementNode;
        visitNode(whileNode.condition);
        visitNode(whileNode.body);
        break;
      }
      case ASTNodeKind.ForStatement: {
        const forNode = node as ForStatementNode;
        if (forNode.initializer) visitNode(forNode.initializer);
        if (forNode.condition) visitNode(forNode.condition);
        if (forNode.incrementor) visitNode(forNode.incrementor);
        visitNode(forNode.body);
        break;
      }
      case ASTNodeKind.ForOfStatement: {
        const forOfNode = node as ForOfStatementNode;
        if (Array.isArray(forOfNode.variable)) {
          for (const name of forOfNode.variable) {
            locals.set(name, ObjectType);
          }
        } else {
          const mappedType = forOfNode.variableType
            ? this.typeMapper.mapTypeScriptType(forOfNode.variableType)
            : ObjectType;
          locals.set(forOfNode.variable, mappedType);
        }
        if (forOfNode.destructureProperties) {
          for (const entry of forOfNode.destructureProperties) {
            locals.set(entry.name, ObjectType);
          }
        }
        visitNode(forOfNode.iterable);
        visitNode(forOfNode.body);
        break;
      }
      case ASTNodeKind.DoWhileStatement: {
        const doNode = node as DoWhileStatementNode;
        visitNode(doNode.body);
        visitNode(doNode.condition);
        break;
      }
      case ASTNodeKind.SwitchStatement: {
        const switchNode = node as SwitchStatementNode;
        visitNode(switchNode.expression);
        for (const clause of switchNode.cases) {
          if (clause.expression) visitNode(clause.expression);
          for (const stmt of clause.statements) visitNode(stmt);
        }
        break;
      }
      case ASTNodeKind.TryCatchStatement: {
        const tryNode = node as TryCatchStatementNode;
        visitNode(tryNode.tryBody);
        if (tryNode.catchVariable) {
          locals.set(tryNode.catchVariable, ObjectType);
        }
        if (tryNode.catchBody) visitNode(tryNode.catchBody);
        if (tryNode.finallyBody) visitNode(tryNode.finallyBody);
        break;
      }
      case ASTNodeKind.CallExpression: {
        const callNode = node as CallExpressionNode;
        visitNode(callNode.callee);
        for (const arg of callNode.arguments) visitNode(arg);
        break;
      }
      case ASTNodeKind.AssignmentExpression: {
        const assignNode = node as AssignmentExpressionNode;
        visitNode(assignNode.target);
        visitNode(assignNode.value);
        break;
      }
      case ASTNodeKind.BinaryExpression: {
        const binNode = node as BinaryExpressionNode;
        visitNode(binNode.left);
        visitNode(binNode.right);
        break;
      }
      case ASTNodeKind.UnaryExpression: {
        const unNode = node as UnaryExpressionNode;
        visitNode(unNode.operand);
        break;
      }
      case ASTNodeKind.ConditionalExpression: {
        const condNode = node as ConditionalExpressionNode;
        visitNode(condNode.condition);
        visitNode(condNode.whenTrue);
        visitNode(condNode.whenFalse);
        break;
      }
      case ASTNodeKind.NullCoalescingExpression: {
        const nullCoalesce = node as NullCoalescingExpressionNode;
        visitNode(nullCoalesce.left);
        visitNode(nullCoalesce.right);
        break;
      }
      case ASTNodeKind.PropertyAccessExpression: {
        const propNode = node as PropertyAccessExpressionNode;
        visitNode(propNode.object);
        break;
      }
      case ASTNodeKind.ReturnStatement: {
        const retNode = node as ReturnStatementNode;
        if (retNode.value) visitNode(retNode.value);
        break;
      }
      case ASTNodeKind.ThrowStatement: {
        const throwNode = node as ThrowStatementNode;
        visitNode(throwNode.expression);
        break;
      }
      case ASTNodeKind.AsExpression: {
        const asNode = node as AsExpressionNode;
        visitNode(asNode.expression);
        break;
      }
      case ASTNodeKind.FunctionExpression: {
        // Do NOT recurse into closure bodies: variables declared inside a
        // closure are not part of the enclosing method's recursion locals.
        break;
      }
      case ASTNodeKind.ArrayLiteralExpression: {
        const arrNode = node as ArrayLiteralExpressionNode;
        for (const elem of arrNode.elements) visitNode(elem.value);
        break;
      }
      case ASTNodeKind.ArrayAccessExpression: {
        const accNode = node as ArrayAccessExpressionNode;
        visitNode(accNode.array);
        visitNode(accNode.index);
        break;
      }
      case ASTNodeKind.TemplateExpression: {
        const tmplNode = node as TemplateExpressionNode;
        for (const part of tmplNode.parts) {
          if (part.kind === "expression") visitNode(part.expression);
        }
        break;
      }
      case ASTNodeKind.ObjectLiteralExpression: {
        const objNode = node as ObjectLiteralExpressionNode;
        for (const prop of objNode.properties) visitNode(prop.value);
        break;
      }
      case ASTNodeKind.DeleteExpression: {
        const delNode = node as DeleteExpressionNode;
        visitNode(delNode.target);
        break;
      }
      case ASTNodeKind.OptionalChainingExpression: {
        const optNode = node as OptionalChainingExpressionNode;
        visitNode(optNode.object);
        break;
      }
      case ASTNodeKind.UpdateExpression: {
        const updNode = node as UpdateExpressionNode;
        visitNode(updNode.operand);
        break;
      }
      default:
        break;
    }
  };

  visitNode(method.body);
  return Array.from(locals.entries()).map(([name, type]) => ({ name, type }));
}

/**
 * Push all locals onto per-local DataList stacks at the current SP.
 * Used at each self-call site BEFORE the JUMP to the recursive method.
 * Increments SP first, then saves all locals at the new SP index.
 */
export function emitCallSitePush(this: ASTToTACConverter): void {
  const context = this.currentRecursiveContext;
  if (!context) return;

  const spVar = createVariable(context.spVar, PrimitiveTypes.int32);

  // Guard: abort if depth has reached MAX_RECURSION_STACK_DEPTH.
  // Without this, set_Item would write beyond the pre-populated DataList bounds.
  // ConditionalJumpInstruction is "ifFalse goto", so we check (depth < MAX)
  // and jump to the shared overflow handler (emitted once in the method
  // prologue) when false (i.e., depth >= MAX).
  const depthVar = createVariable(context.depthVar, PrimitiveTypes.int32);
  const depthOk = this.newTemp(PrimitiveTypes.boolean);
  this.instructions.push(
    new BinaryOpInstruction(
      depthOk,
      depthVar,
      "<",
      createConstant(MAX_RECURSION_STACK_DEPTH, PrimitiveTypes.int32),
    ),
  );
  this.instructions.push(
    new ConditionalJumpInstruction(depthOk, context.overflowLabel),
  );

  // SP++
  const spTemp = this.newTemp(PrimitiveTypes.int32);
  this.instructions.push(
    new BinaryOpInstruction(
      spTemp,
      spVar,
      "+",
      createConstant(1, PrimitiveTypes.int32),
    ),
  );
  this.emitCopyWithTracking(spVar, spTemp);

  // Save each local at stack[SP]
  for (let index = 0; index < context.locals.length; index++) {
    const local = context.locals[index];
    const stackVarInfo = context.stackVars[index];
    const stackVar = createVariable(stackVarInfo.name, ExternTypes.dataList);
    const localVar = createVariable(local.name, local.type, {
      isLocal: true,
    });
    const token = this.wrapDataToken(localVar);
    this.instructions.push(
      new MethodCallInstruction(undefined, stackVar, "set_Item", [
        spVar,
        token,
      ]),
    );
  }
}

/**
 * Pop all locals from per-local DataList stacks at the current SP.
 * Used at each self-call site AFTER the return label (after reading the return value).
 * Restores all locals from the current SP index, then decrements SP.
 */
export function emitCallSitePop(this: ASTToTACConverter): void {
  const context = this.currentRecursiveContext;
  if (!context) return;

  const spVar = createVariable(context.spVar, PrimitiveTypes.int32);

  // Guard: SP must be >= 0 before pop (mirrors the depth guard in push).
  // If this fires it indicates a push/pop imbalance in code-gen.
  // ConditionalJumpInstruction is "ifFalse goto", so we check (SP >= 0)
  // and jump to the underflow handler when false (i.e., SP < 0).
  const spOk = this.newTemp(PrimitiveTypes.boolean);
  this.instructions.push(
    new BinaryOpInstruction(
      spOk,
      spVar,
      ">=",
      createConstant(0, PrimitiveTypes.int32),
    ),
  );
  const underflowLabel = this.newLabel("pop_underflow");
  const afterPopLabel = this.newLabel("after_pop");
  this.instructions.push(new ConditionalJumpInstruction(spOk, underflowLabel));

  // Restore each local from stack[SP]
  for (let index = 0; index < context.locals.length; index++) {
    const local = context.locals[index];
    const stackVarInfo = context.stackVars[index];
    const stackVar = createVariable(stackVarInfo.name, ExternTypes.dataList);
    const token = this.newTemp(ExternTypes.dataToken);
    this.instructions.push(
      new MethodCallInstruction(token, stackVar, "get_Item", [spVar]),
    );
    const unwrapped = this.unwrapDataToken(token, local.type);
    // Plain copy: must NOT use emitCopyWithTracking here because
    // unwrapDataToken returns a fresh temp with no tracking info, and
    // emitCopyWithTracking would clear the local's pre-existing
    // inlineInstanceMap entry. The local's inline tracking remains valid
    // across the recursive call since the instance identity is unchanged.
    this.instructions.push(
      new CopyInstruction(
        createVariable(local.name, local.type, { isLocal: true }),
        unwrapped,
      ),
    );
  }

  // SP--
  const spTemp = this.newTemp(PrimitiveTypes.int32);
  this.instructions.push(
    new BinaryOpInstruction(
      spTemp,
      spVar,
      "-",
      createConstant(1, PrimitiveTypes.int32),
    ),
  );
  this.emitCopyWithTracking(spVar, spTemp);
  this.instructions.push(new UnconditionalJumpInstruction(afterPopLabel));

  // Underflow handler: log error and skip restore
  this.instructions.push(new LabelInstruction(underflowLabel));
  const logErrorExtern = this.requireExternSignature(
    "Debug",
    "LogError",
    "method",
    ["object"],
    "void",
  );
  const underflowMsg = createConstant(
    "[udon-assembly-ts] Stack underflow: pop without matching push.",
    PrimitiveTypes.string,
  );
  this.instructions.push(
    new CallInstruction(undefined, logErrorExtern, [underflowMsg]),
  );

  this.instructions.push(new LabelInstruction(afterPopLabel));
}

/**
 * Count the number of TryCatchStatement nodes in a method body.
 * Used to predict compiler-synthesized __error_flag_* / __error_value_*
 * variable names for inclusion in the recursion push/pop set.
 */
export function countTryCatchBlocks(body: BlockStatementNode): number {
  let count = 0;
  const visitNode = (node: ASTNode): void => {
    // Do not recurse into closures — they have separate try/catch scope
    if (node.kind === ASTNodeKind.FunctionExpression) return;
    if (node.kind === ASTNodeKind.TryCatchStatement) {
      count++;
      const tryNode = node as TryCatchStatementNode;
      visitNode(tryNode.tryBody);
      if (tryNode.catchBody) visitNode(tryNode.catchBody);
      if (tryNode.finallyBody) visitNode(tryNode.finallyBody);
    } else if (node.kind === ASTNodeKind.BlockStatement) {
      for (const stmt of (node as BlockStatementNode).statements) {
        visitNode(stmt);
      }
    } else if (node.kind === ASTNodeKind.IfStatement) {
      const ifNode = node as IfStatementNode;
      visitNode(ifNode.thenBranch);
      if (ifNode.elseBranch) visitNode(ifNode.elseBranch);
    } else if (node.kind === ASTNodeKind.WhileStatement) {
      visitNode((node as WhileStatementNode).body);
    } else if (node.kind === ASTNodeKind.DoWhileStatement) {
      visitNode((node as DoWhileStatementNode).body);
    } else if (node.kind === ASTNodeKind.ForStatement) {
      visitNode((node as ForStatementNode).body);
    } else if (node.kind === ASTNodeKind.ForOfStatement) {
      visitNode((node as ForOfStatementNode).body);
    } else if (node.kind === ASTNodeKind.SwitchStatement) {
      for (const c of (node as SwitchStatementNode).cases) {
        for (const stmt of c.statements) visitNode(stmt);
      }
    }
  };
  visitNode(body);
  return count;
}

/**
 * Count the number of self-recursive calls (this.methodName(...)) in a method body.
 * Used to pre-allocate selfCallResult variables that survive across sibling calls.
 */
export function countSelfCalls(
  methodName: string,
  body: BlockStatementNode,
): number {
  let count = 0;
  const visitNode = (node: ASTNode): void => {
    switch (node.kind) {
      case ASTNodeKind.CallExpression: {
        const callNode = node as CallExpressionNode;
        if (callNode.callee.kind === ASTNodeKind.PropertyAccessExpression) {
          const propAccess = callNode.callee as PropertyAccessExpressionNode;
          if (
            propAccess.object.kind === ASTNodeKind.ThisExpression &&
            propAccess.property === methodName
          ) {
            count++;
          }
        }
        visitNode(callNode.callee);
        for (const arg of callNode.arguments) visitNode(arg);
        break;
      }
      case ASTNodeKind.BlockStatement: {
        const block = node as BlockStatementNode;
        for (const stmt of block.statements) visitNode(stmt);
        break;
      }
      case ASTNodeKind.IfStatement: {
        const ifNode = node as IfStatementNode;
        visitNode(ifNode.condition);
        visitNode(ifNode.thenBranch);
        if (ifNode.elseBranch) visitNode(ifNode.elseBranch);
        break;
      }
      case ASTNodeKind.WhileStatement: {
        const whileNode = node as WhileStatementNode;
        visitNode(whileNode.condition);
        visitNode(whileNode.body);
        break;
      }
      case ASTNodeKind.ForStatement: {
        const forNode = node as ForStatementNode;
        if (forNode.initializer) visitNode(forNode.initializer);
        if (forNode.condition) visitNode(forNode.condition);
        if (forNode.incrementor) visitNode(forNode.incrementor);
        visitNode(forNode.body);
        break;
      }
      case ASTNodeKind.ForOfStatement: {
        const forOfNode = node as ForOfStatementNode;
        visitNode(forOfNode.iterable);
        visitNode(forOfNode.body);
        break;
      }
      case ASTNodeKind.DoWhileStatement: {
        const doNode = node as DoWhileStatementNode;
        visitNode(doNode.body);
        visitNode(doNode.condition);
        break;
      }
      case ASTNodeKind.SwitchStatement: {
        const switchNode = node as SwitchStatementNode;
        visitNode(switchNode.expression);
        for (const clause of switchNode.cases) {
          if (clause.expression) visitNode(clause.expression);
          for (const stmt of clause.statements) visitNode(stmt);
        }
        break;
      }
      case ASTNodeKind.TryCatchStatement: {
        const tryNode = node as TryCatchStatementNode;
        visitNode(tryNode.tryBody);
        if (tryNode.catchBody) visitNode(tryNode.catchBody);
        if (tryNode.finallyBody) visitNode(tryNode.finallyBody);
        break;
      }
      case ASTNodeKind.ReturnStatement: {
        const retNode = node as ReturnStatementNode;
        if (retNode.value) visitNode(retNode.value);
        break;
      }
      case ASTNodeKind.ThrowStatement: {
        const throwNode = node as ThrowStatementNode;
        visitNode(throwNode.expression);
        break;
      }
      case ASTNodeKind.BinaryExpression: {
        const binNode = node as BinaryExpressionNode;
        visitNode(binNode.left);
        visitNode(binNode.right);
        break;
      }
      case ASTNodeKind.UnaryExpression: {
        const unNode = node as UnaryExpressionNode;
        visitNode(unNode.operand);
        break;
      }
      case ASTNodeKind.ConditionalExpression: {
        const condNode = node as ConditionalExpressionNode;
        visitNode(condNode.condition);
        visitNode(condNode.whenTrue);
        visitNode(condNode.whenFalse);
        break;
      }
      case ASTNodeKind.NullCoalescingExpression: {
        const nullCoalesce = node as NullCoalescingExpressionNode;
        visitNode(nullCoalesce.left);
        visitNode(nullCoalesce.right);
        break;
      }
      case ASTNodeKind.AssignmentExpression: {
        const assignNode = node as AssignmentExpressionNode;
        visitNode(assignNode.target);
        visitNode(assignNode.value);
        break;
      }
      case ASTNodeKind.VariableDeclaration: {
        const varNode = node as VariableDeclarationNode;
        if (varNode.initializer) visitNode(varNode.initializer);
        break;
      }
      case ASTNodeKind.PropertyAccessExpression: {
        const propNode = node as PropertyAccessExpressionNode;
        visitNode(propNode.object);
        break;
      }
      case ASTNodeKind.AsExpression: {
        const asNode = node as AsExpressionNode;
        visitNode(asNode.expression);
        break;
      }
      case ASTNodeKind.FunctionExpression: {
        // Do NOT recurse into closure bodies: self-calls inside a closure
        // go through a different runtime path and should not count toward
        // the __selfCallResult_* pre-allocation for the enclosing method.
        break;
      }
      case ASTNodeKind.ArrayLiteralExpression: {
        const arrNode = node as ArrayLiteralExpressionNode;
        for (const elem of arrNode.elements) visitNode(elem.value);
        break;
      }
      case ASTNodeKind.ArrayAccessExpression: {
        const accNode = node as ArrayAccessExpressionNode;
        visitNode(accNode.array);
        visitNode(accNode.index);
        break;
      }
      case ASTNodeKind.TemplateExpression: {
        const tmplNode = node as TemplateExpressionNode;
        for (const part of tmplNode.parts) {
          if (part.kind === "expression") visitNode(part.expression);
        }
        break;
      }
      case ASTNodeKind.ObjectLiteralExpression: {
        const objNode = node as ObjectLiteralExpressionNode;
        for (const prop of objNode.properties) visitNode(prop.value);
        break;
      }
      case ASTNodeKind.DeleteExpression: {
        const delNode = node as DeleteExpressionNode;
        visitNode(delNode.target);
        break;
      }
      case ASTNodeKind.OptionalChainingExpression: {
        const optNode = node as OptionalChainingExpressionNode;
        visitNode(optNode.object);
        break;
      }
      case ASTNodeKind.UpdateExpression: {
        const updNode = node as UpdateExpressionNode;
        visitNode(updNode.operand);
        break;
      }
      default:
        break;
    }
  };
  visitNode(body);
  return count;
}

/**
 * Count the number of static self-calls in an inline class method body.
 * Matches `ClassName.methodName(...)` patterns (as opposed to countSelfCalls
 * which matches `this.methodName(...)`).
 */
export function countStaticSelfCalls(
  className: string,
  methodName: string,
  body: BlockStatementNode,
): number {
  let count = 0;
  const visitNode = (node: ASTNode): void => {
    switch (node.kind) {
      case ASTNodeKind.CallExpression: {
        const callNode = node as CallExpressionNode;
        if (callNode.callee.kind === ASTNodeKind.PropertyAccessExpression) {
          const propAccess = callNode.callee as PropertyAccessExpressionNode;
          if (
            propAccess.object.kind === ASTNodeKind.Identifier &&
            (propAccess.object as IdentifierNode).name === className &&
            propAccess.property === methodName
          ) {
            count++;
          }
        }
        visitNode(callNode.callee);
        for (const arg of callNode.arguments) visitNode(arg);
        break;
      }
      case ASTNodeKind.ExpressionStatement: {
        const exprStmt = node as ExpressionStatementNode;
        visitNode(exprStmt.expression);
        break;
      }
      case ASTNodeKind.BlockStatement: {
        const block = node as BlockStatementNode;
        for (const stmt of block.statements) visitNode(stmt);
        break;
      }
      case ASTNodeKind.IfStatement: {
        const ifNode = node as IfStatementNode;
        visitNode(ifNode.condition);
        visitNode(ifNode.thenBranch);
        if (ifNode.elseBranch) visitNode(ifNode.elseBranch);
        break;
      }
      case ASTNodeKind.WhileStatement: {
        const whileNode = node as WhileStatementNode;
        visitNode(whileNode.condition);
        visitNode(whileNode.body);
        break;
      }
      case ASTNodeKind.ForStatement: {
        const forNode = node as ForStatementNode;
        if (forNode.initializer) visitNode(forNode.initializer);
        if (forNode.condition) visitNode(forNode.condition);
        if (forNode.incrementor) visitNode(forNode.incrementor);
        visitNode(forNode.body);
        break;
      }
      case ASTNodeKind.ForOfStatement: {
        const forOfNode = node as ForOfStatementNode;
        visitNode(forOfNode.iterable);
        visitNode(forOfNode.body);
        break;
      }
      case ASTNodeKind.DoWhileStatement: {
        const doNode = node as DoWhileStatementNode;
        visitNode(doNode.body);
        visitNode(doNode.condition);
        break;
      }
      case ASTNodeKind.SwitchStatement: {
        const switchNode = node as SwitchStatementNode;
        visitNode(switchNode.expression);
        for (const clause of switchNode.cases) {
          if (clause.expression) visitNode(clause.expression);
          for (const stmt of clause.statements) visitNode(stmt);
        }
        break;
      }
      case ASTNodeKind.TryCatchStatement: {
        const tryNode = node as TryCatchStatementNode;
        visitNode(tryNode.tryBody);
        if (tryNode.catchBody) visitNode(tryNode.catchBody);
        if (tryNode.finallyBody) visitNode(tryNode.finallyBody);
        break;
      }
      case ASTNodeKind.ReturnStatement: {
        const retNode = node as ReturnStatementNode;
        if (retNode.value) visitNode(retNode.value);
        break;
      }
      case ASTNodeKind.ThrowStatement: {
        const throwNode = node as ThrowStatementNode;
        visitNode(throwNode.expression);
        break;
      }
      case ASTNodeKind.BinaryExpression: {
        const binNode = node as BinaryExpressionNode;
        visitNode(binNode.left);
        visitNode(binNode.right);
        break;
      }
      case ASTNodeKind.UnaryExpression: {
        const unNode = node as UnaryExpressionNode;
        visitNode(unNode.operand);
        break;
      }
      case ASTNodeKind.ConditionalExpression: {
        const condNode = node as ConditionalExpressionNode;
        visitNode(condNode.condition);
        visitNode(condNode.whenTrue);
        visitNode(condNode.whenFalse);
        break;
      }
      case ASTNodeKind.NullCoalescingExpression: {
        const nullCoalesce = node as NullCoalescingExpressionNode;
        visitNode(nullCoalesce.left);
        visitNode(nullCoalesce.right);
        break;
      }
      case ASTNodeKind.AssignmentExpression: {
        const assignNode = node as AssignmentExpressionNode;
        visitNode(assignNode.target);
        visitNode(assignNode.value);
        break;
      }
      case ASTNodeKind.VariableDeclaration: {
        const varNode = node as VariableDeclarationNode;
        if (varNode.initializer) visitNode(varNode.initializer);
        break;
      }
      case ASTNodeKind.PropertyAccessExpression: {
        const propNode = node as PropertyAccessExpressionNode;
        visitNode(propNode.object);
        break;
      }
      case ASTNodeKind.FunctionExpression:
        break;
      case ASTNodeKind.ArrayLiteralExpression: {
        const arrNode = node as ArrayLiteralExpressionNode;
        for (const elem of arrNode.elements) visitNode(elem.value);
        break;
      }
      case ASTNodeKind.ArrayAccessExpression: {
        const accNode = node as ArrayAccessExpressionNode;
        visitNode(accNode.array);
        visitNode(accNode.index);
        break;
      }
      case ASTNodeKind.AsExpression: {
        const asNode = node as AsExpressionNode;
        visitNode(asNode.expression);
        break;
      }
      case ASTNodeKind.TemplateExpression: {
        const tmplNode = node as TemplateExpressionNode;
        for (const part of tmplNode.parts) {
          if (part.kind === "expression") visitNode(part.expression);
        }
        break;
      }
      case ASTNodeKind.ObjectLiteralExpression: {
        const objNode = node as ObjectLiteralExpressionNode;
        for (const prop of objNode.properties) visitNode(prop.value);
        break;
      }
      case ASTNodeKind.DeleteExpression: {
        const delNode = node as DeleteExpressionNode;
        visitNode(delNode.target);
        break;
      }
      case ASTNodeKind.OptionalChainingExpression: {
        const optNode = node as OptionalChainingExpressionNode;
        visitNode(optNode.object);
        break;
      }
      case ASTNodeKind.UpdateExpression: {
        const updNode = node as UpdateExpressionNode;
        visitNode(updNode.operand);
        break;
      }
      // NameofExpression and TypeofExpression are compile-time constructs
      // that never contain self-calls — skip without recursing.
      case ASTNodeKind.NameofExpression:
      case ASTNodeKind.TypeofExpression:
        break;
      default:
        break;
    }
  };
  visitNode(body);
  return count;
}

/**
 * Push all locals onto per-local DataList stacks for inline recursive context.
 * Same logic as emitCallSitePush but uses currentInlineRecursiveContext.
 */
export function emitInlineRecursivePush(this: ASTToTACConverter): void {
  const context = this.currentInlineRecursiveContext;
  if (!context) return;

  const spVar = createVariable(context.spVar, PrimitiveTypes.int32);

  // Guard: abort if depth has reached MAX_RECURSION_STACK_DEPTH.
  // ConditionalJumpInstruction is "ifFalse goto": we check (depth < MAX)
  // and jump to overflow when false (i.e., depth >= MAX).
  const depthVar = createVariable(context.depthVar, PrimitiveTypes.int32);
  const depthOk = this.newTemp(PrimitiveTypes.boolean);
  this.instructions.push(
    new BinaryOpInstruction(
      depthOk,
      depthVar,
      "<",
      createConstant(MAX_RECURSION_STACK_DEPTH, PrimitiveTypes.int32),
    ),
  );
  this.instructions.push(
    new ConditionalJumpInstruction(depthOk, context.overflowLabel),
  );

  // SP++
  const spTemp = this.newTemp(PrimitiveTypes.int32);
  this.instructions.push(
    new BinaryOpInstruction(
      spTemp,
      spVar,
      "+",
      createConstant(1, PrimitiveTypes.int32),
    ),
  );
  this.emitCopyWithTracking(spVar, spTemp);

  // Save each local at stack[SP]
  for (let index = 0; index < context.locals.length; index++) {
    const local = context.locals[index];
    const stackVarInfo = context.stackVars[index];
    const stackVar = createVariable(stackVarInfo.name, ExternTypes.dataList);
    const localVar = createVariable(local.name, local.type, {
      isLocal: true,
    });
    const token = this.wrapDataToken(localVar);
    this.instructions.push(
      new MethodCallInstruction(undefined, stackVar, "set_Item", [
        spVar,
        token,
      ]),
    );
  }
}

/**
 * Pop all locals from per-local DataList stacks for inline recursive context.
 * Same logic as emitCallSitePop but uses currentInlineRecursiveContext.
 */
export function emitInlineRecursivePop(this: ASTToTACConverter): void {
  const context = this.currentInlineRecursiveContext;
  if (!context) return;

  const spVar = createVariable(context.spVar, PrimitiveTypes.int32);

  // Guard: SP must be >= 0 before pop.
  const spOk = this.newTemp(PrimitiveTypes.boolean);
  this.instructions.push(
    new BinaryOpInstruction(
      spOk,
      spVar,
      ">=",
      createConstant(0, PrimitiveTypes.int32),
    ),
  );
  const underflowLabel = this.newLabel("inline_rec_pop_underflow");
  const afterPopLabel = this.newLabel("inline_rec_after_pop");
  this.instructions.push(new ConditionalJumpInstruction(spOk, underflowLabel));

  // Restore each local from stack[SP].
  // Plain CopyInstruction (not emitCopyWithTracking): unwrapDataToken
  // returns a fresh temp with no tracking info. inlineInstanceMap is
  // restored separately in step 8b of emitInlineRecursiveSelfCall.
  for (let index = 0; index < context.locals.length; index++) {
    const local = context.locals[index];
    const stackVarInfo = context.stackVars[index];
    const stackVar = createVariable(stackVarInfo.name, ExternTypes.dataList);
    const token = this.newTemp(ExternTypes.dataToken);
    this.instructions.push(
      new MethodCallInstruction(token, stackVar, "get_Item", [spVar]),
    );
    const unwrapped = this.unwrapDataToken(token, local.type);
    this.instructions.push(
      new CopyInstruction(
        createVariable(local.name, local.type, { isLocal: true }),
        unwrapped,
      ),
    );
  }

  // SP--
  const spTemp = this.newTemp(PrimitiveTypes.int32);
  this.instructions.push(
    new BinaryOpInstruction(
      spTemp,
      spVar,
      "-",
      createConstant(1, PrimitiveTypes.int32),
    ),
  );
  this.emitCopyWithTracking(spVar, spTemp);
  this.instructions.push(new UnconditionalJumpInstruction(afterPopLabel));

  // Underflow handler
  this.instructions.push(new LabelInstruction(underflowLabel));
  const logErrorExtern = this.requireExternSignature(
    "Debug",
    "LogError",
    "method",
    ["object"],
    "void",
  );
  const underflowMsg = createConstant(
    "[udon-assembly-ts] Inline recursive stack underflow.",
    PrimitiveTypes.string,
  );
  this.instructions.push(
    new CallInstruction(undefined, logErrorExtern, [underflowMsg]),
  );

  this.instructions.push(new LabelInstruction(afterPopLabel));
}

/**
 * Emit a dispatch table that replaces JUMP_INDIRECT for recursive returns.
 * After the epilogue restores __returnSiteIdx, this checks the index against
 * each known return site and jumps to the corresponding label.
 * If no return site matches (depth == 0, initial call), emit a normal return.
 */
export function emitReturnSiteDispatch(this: ASTToTACConverter): void {
  const context = this.currentRecursiveContext;
  if (!context) return;

  const methodName = this.currentMethodName;
  if (!methodName) return;

  if (!this.currentClassName) {
    throw new Error(
      `emitReturnSiteDispatch: missing currentClassName for method ${methodName}`,
    );
  }

  const returnSiteIdxVar = createVariable(
    `__returnSiteIdx_${this.currentClassName}_${methodName}`,
    PrimitiveTypes.int32,
    { isLocal: true },
  );
  const registryKey = `${this.currentClassName}.${methodName}`;
  const registry = this.recursiveReturnSites.get(registryKey);
  // The registry is always populated because non-recursive methods are
  // compiled before recursive ones (see orderedMethods in statement.ts).
  // Fall back to context.returnSites only for self-call-only methods
  // (no external callers registered a return site).
  const allSites = registry?.sites ?? context.returnSites;

  for (const site of allSites) {
    const cmpResult = this.newTemp(PrimitiveTypes.boolean);
    this.instructions.push(
      new BinaryOpInstruction(
        cmpResult,
        returnSiteIdxVar,
        "!=",
        createConstant(site.index, PrimitiveTypes.int32),
      ),
    );
    const siteLabel = createLabel(site.labelName);
    this.instructions.push(
      new ConditionalJumpInstruction(cmpResult, siteLabel),
    );
  }

  // Defensive fallback: should be unreachable in correct code because every
  // return-site index that can be live at method exit is registered in allSites.
  // Reached only if the method is never called (allSites is empty) or if
  // returnSiteIdx holds an unregistered value.
  this.instructions.push(
    new ReturnInstruction(undefined, this.currentReturnVar),
  );
}
