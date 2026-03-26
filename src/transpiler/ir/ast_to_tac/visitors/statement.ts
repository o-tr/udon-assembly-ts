import type { TypeSymbol } from "../../../frontend/type_symbols.js";
import {
  ArrayTypeSymbol,
  DataListTypeSymbol,
  ExternTypes,
  InterfaceTypeSymbol,
  ObjectType,
  PrimitiveTypes,
} from "../../../frontend/type_symbols.js";
import {
  type ASTNode,
  ASTNodeKind,
  type BlockStatementNode,
  type BreakStatementNode,
  type ClassDeclarationNode,
  type ContinueStatementNode,
  type DoWhileStatementNode,
  type EnumDeclarationNode,
  type ExpressionStatementNode,
  type ForOfStatementNode,
  type ForStatementNode,
  type IfStatementNode,
  type ReturnStatementNode,
  type SwitchStatementNode,
  type ThrowStatementNode,
  type TryCatchStatementNode,
  UdonType,
  type VariableDeclarationNode,
  type WhileStatementNode,
} from "../../../frontend/types.js";
import { getVrcEventDefinition } from "../../../vrc/event_registry.js";
import {
  ArrayAccessInstruction,
  AssignmentInstruction,
  BinaryOpInstruction,
  CallInstruction,
  ConditionalJumpInstruction,
  CopyInstruction,
  LabelInstruction,
  MethodCallInstruction,
  PropertyGetInstruction,
  ReturnInstruction,
  type TACInstruction,
  UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import {
  createConstant,
  createLabel,
  createVariable,
  type TACOperand,
  TACOperandKind,
  type VariableOperand,
} from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";
import {
  emitMapEntriesList,
  isMapCollectionType,
  isSetCollectionType,
} from "../helpers/collections.js";
import {
  countSelfCalls,
  countTryCatchBlocks,
  MAX_RECURSION_STACK_DEPTH,
} from "../helpers/inline.js";
import { isAllInlineInterface } from "../helpers/udon_behaviour.js";
import { resolveTypeFromNode } from "./expression.js";

function emitLoopExitEpilogues(converter: ASTToTACConverter): void {
  for (let i = converter.loopContextStack.length - 1; i >= 0; i -= 1) {
    converter.loopContextStack[i].emitExitEpilogue?.();
  }
}

function emitLoopExitEpiloguesSinceDepth(
  converter: ASTToTACConverter,
  depth: number,
): void {
  for (let i = converter.loopContextStack.length - 1; i >= depth; i -= 1) {
    converter.loopContextStack[i].emitExitEpilogue?.();
  }
}

export function visitStatement(this: ASTToTACConverter, node: ASTNode): void {
  switch (node.kind) {
    case ASTNodeKind.VariableDeclaration:
      this.visitVariableDeclaration(node as VariableDeclarationNode);
      break;
    case ASTNodeKind.IfStatement:
      this.visitIfStatement(node as IfStatementNode);
      break;
    case ASTNodeKind.WhileStatement:
      this.visitWhileStatement(node as WhileStatementNode);
      break;
    case ASTNodeKind.SwitchStatement:
      this.visitSwitchStatement(node as SwitchStatementNode);
      break;
    case ASTNodeKind.DoWhileStatement:
      this.visitDoWhileStatement(node as DoWhileStatementNode);
      break;
    case ASTNodeKind.ForOfStatement:
      this.visitForOfStatement(node as ForOfStatementNode);
      break;
    case ASTNodeKind.BreakStatement:
      this.visitBreakStatement(node as BreakStatementNode);
      break;
    case ASTNodeKind.ContinueStatement:
      this.visitContinueStatement(node as ContinueStatementNode);
      break;
    case ASTNodeKind.ReturnStatement:
      this.visitReturnStatement(node as ReturnStatementNode);
      break;
    case ASTNodeKind.BlockStatement:
      if (this.isDestructureBlock(node as BlockStatementNode)) {
        this.visitInlineBlockStatement(node as BlockStatementNode);
      } else {
        this.visitBlockStatement(node as BlockStatementNode);
      }
      break;
    case ASTNodeKind.ForStatement:
      this.visitForStatement(node as ForStatementNode);
      break;
    case ASTNodeKind.EnumDeclaration:
      this.visitEnumDeclaration(node as EnumDeclarationNode);
      break;
    case ASTNodeKind.ClassDeclaration:
      this.visitClassDeclaration(node as ClassDeclarationNode);
      break;
    case ASTNodeKind.TryCatchStatement:
      this.visitTryCatchStatement(node as TryCatchStatementNode);
      break;
    case ASTNodeKind.ThrowStatement:
      this.visitThrowStatement(node as ThrowStatementNode);
      break;
    case ASTNodeKind.ExpressionStatement:
      this.visitExpression((node as ExpressionStatementNode).expression);
      break;
    case ASTNodeKind.AssignmentExpression:
    case ASTNodeKind.CallExpression:
    case ASTNodeKind.BinaryExpression:
    case ASTNodeKind.UnaryExpression:
    case ASTNodeKind.ConditionalExpression:
    case ASTNodeKind.NullCoalescingExpression:
    case ASTNodeKind.TemplateExpression:
    case ASTNodeKind.Literal:
    case ASTNodeKind.Identifier:
    case ASTNodeKind.ThisExpression:
    case ASTNodeKind.SuperExpression:
    case ASTNodeKind.ObjectLiteralExpression:
    case ASTNodeKind.DeleteExpression:
    case ASTNodeKind.ArrayLiteralExpression:
    case ASTNodeKind.PropertyAccessExpression:
    case ASTNodeKind.AsExpression:
    case ASTNodeKind.ArrayAccessExpression:
    case ASTNodeKind.NameofExpression:
    case ASTNodeKind.TypeofExpression:
    case ASTNodeKind.OptionalChainingExpression:
    case ASTNodeKind.UpdateExpression:
      this.visitExpression(node);
      break;
  }
}

export function visitVariableDeclaration(
  this: ASTToTACConverter,
  node: VariableDeclarationNode,
): void {
  // Top-level literal constants are inlined at use-site; just register in symbol table
  if (
    node.isConst &&
    this.symbolTable.getCurrentScope() === 0 &&
    node.initializer?.kind === ASTNodeKind.Literal
  ) {
    if (!this.symbolTable.hasInCurrentScope(node.name)) {
      this.symbolTable.addSymbol(
        node.name,
        node.type,
        false,
        true,
        node.initializer,
      );
    }
    return;
  }

  const isObjectTypeSymbol = (type: TypeSymbol): boolean =>
    type.name === ObjectType.name && type.udonType === ObjectType.udonType;
  let destType: TypeSymbol = node.type;
  let src: TACOperand | null = null;

  if (node.initializer) {
    if (
      node.initializer.kind === ASTNodeKind.ObjectLiteralExpression &&
      node.type instanceof InterfaceTypeSymbol &&
      node.type.properties.size > 0
    ) {
      const prev = this.currentExpectedType;
      this.currentExpectedType = node.type;
      src = this.visitExpression(node.initializer);
      this.currentExpectedType = prev;
    } else {
      src = this.visitExpression(node.initializer);
    }

    if (
      isObjectTypeSymbol(destType) ||
      (destType.name === PrimitiveTypes.single.name &&
        destType.udonType === PrimitiveTypes.single.udonType)
    ) {
      const inferredType = this.getOperandType(src);
      if (!isObjectTypeSymbol(inferredType)) {
        destType = inferredType;
      } else {
        const resolvedType = resolveTypeFromNode(this, node.initializer);
        if (resolvedType && !isObjectTypeSymbol(resolvedType)) {
          destType = resolvedType;
        }
      }
    }
    // When declared type is ArrayTypeSymbol but initializer is new Array<T>()
    // (CallExpression), use the DataList type for correct runtime operations.
    // This does NOT apply to array literals [1, 2, 3] which also produce DataList
    // but are handled differently in existing code paths.
    if (
      destType instanceof ArrayTypeSymbol &&
      node.initializer?.kind === ASTNodeKind.CallExpression
    ) {
      const inferredType = this.getOperandType(src);
      if (inferredType instanceof DataListTypeSymbol) {
        destType = inferredType;
      }
    }
  }

  const isLocal = this.symbolTable.getCurrentScope() > 0;
  const dest = createVariable(node.name, destType, { isLocal });

  if (!this.symbolTable.hasInCurrentScope(node.name)) {
    this.symbolTable.addSymbol(
      node.name,
      destType,
      false,
      node.isConst,
      node.initializer,
    );
  } else {
    this.symbolTable.updateTypeInCurrentScope(node.name, destType);
    if (node.initializer) {
      this.symbolTable.updateInitialValueInCurrentScope(
        node.name,
        node.initializer,
      );
    }
  }

  if (src) {
    this.instructions.push(new AssignmentInstruction(dest, src));
    this.maybeTrackInlineInstanceAssignment(dest, src);
  }
}

export function visitIfStatement(
  this: ASTToTACConverter,
  node: IfStatementNode,
): void {
  const condition = this.visitExpression(node.condition);
  const elseLabel = this.newLabel("else");
  const endLabel = this.newLabel("endif");

  this.instructions.push(new ConditionalJumpInstruction(condition, elseLabel));

  // Then branch
  this.visitStatement(node.thenBranch);
  this.instructions.push(new UnconditionalJumpInstruction(endLabel));

  // Else branch
  this.instructions.push(new LabelInstruction(elseLabel));
  if (node.elseBranch) {
    this.visitStatement(node.elseBranch);
  }

  // End label
  this.instructions.push(new LabelInstruction(endLabel));
}

export function visitWhileStatement(
  this: ASTToTACConverter,
  node: WhileStatementNode,
): void {
  const startLabel = this.newLabel("while_start");
  const endLabel = this.newLabel("while_end");

  // Start label
  this.instructions.push(new LabelInstruction(startLabel));

  // Condition
  const condition = this.visitExpression(node.condition);
  this.instructions.push(new ConditionalJumpInstruction(condition, endLabel));

  // Body
  this.loopContextStack.push({
    breakLabel: endLabel,
    continueLabel: startLabel,
  });
  this.visitStatement(node.body);
  this.loopContextStack.pop();

  // Jump back to start
  this.instructions.push(new UnconditionalJumpInstruction(startLabel));

  // End label
  this.instructions.push(new LabelInstruction(endLabel));
}

export function visitForStatement(
  this: ASTToTACConverter,
  node: ForStatementNode,
): void {
  if (node.initializer) {
    if (this.isStatementNode(node.initializer)) {
      this.visitStatement(node.initializer);
    } else {
      this.visitExpression(node.initializer);
    }
  }

  const startLabel = this.newLabel("for_start");
  const endLabel = this.newLabel("for_end");

  this.instructions.push(new LabelInstruction(startLabel));

  if (node.condition) {
    const condition = this.visitExpression(node.condition);
    this.instructions.push(new ConditionalJumpInstruction(condition, endLabel));
  }

  const continueLabel = this.newLabel("for_continue");
  this.loopContextStack.push({
    breakLabel: endLabel,
    continueLabel,
  });
  this.visitStatement(node.body);
  this.loopContextStack.pop();

  this.instructions.push(new LabelInstruction(continueLabel));
  if (node.incrementor) {
    this.visitExpression(node.incrementor);
  }

  this.instructions.push(new UnconditionalJumpInstruction(startLabel));
  this.instructions.push(new LabelInstruction(endLabel));
}

export function visitForOfStatement(
  this: ASTToTACConverter,
  node: ForOfStatementNode,
): void {
  let iterableOperand = this.visitExpression(node.iterable);
  const inferredIterableType = resolveTypeFromNode(this, node.iterable);
  const operandType = this.getOperandType(iterableOperand);
  const inferredMapType = isMapCollectionType(operandType)
    ? operandType
    : isMapCollectionType(inferredIterableType)
      ? inferredIterableType
      : null;
  const inferredSetType = isSetCollectionType(operandType)
    ? operandType
    : isSetCollectionType(inferredIterableType)
      ? inferredIterableType
      : null;

  if (inferredMapType) {
    // keyType omitted — defaults to ExternTypes.dataToken, which is correct
    // because DataDictionary.GetKeys() always returns DataToken-wrapped keys.
    const entriesList = emitMapEntriesList(this, iterableOperand);
    iterableOperand = entriesList;
  } else if (inferredSetType) {
    const elementType = inferredSetType.elementType ?? ObjectType;
    const listType = new DataListTypeSymbol(elementType);
    const listResult = this.newTemp(listType);
    this.instructions.push(
      new MethodCallInstruction(listResult, iterableOperand, "GetKeys", []),
    );
    iterableOperand = listResult;
  }

  const iterableType = this.getOperandType(iterableOperand);
  const inferredElementType =
    iterableType instanceof ArrayTypeSymbol
      ? iterableType.elementType
      : iterableType instanceof DataListTypeSymbol
        ? iterableType.elementType
        : iterableType?.name === ExternTypes.dataList.name
          ? ObjectType
          : null;
  // Only unwrap DataToken elements when we have a DataListTypeSymbol (e.g.,
  // Set iteration via GetKeys() yields DataListTypeSymbol) so we can use the
  // element type. When matching ExternTypes.dataList or UdonType.DataList by
  // name, elements come from DataList.get_Item as raw DataToken and must stay
  // unwrapped.
  const isDataList =
    iterableType instanceof DataListTypeSymbol ||
    iterableType.name === ExternTypes.dataList.name ||
    iterableType.udonType === UdonType.DataList;
  const indexVar = this.newTemp(PrimitiveTypes.int32);
  const lengthVar = this.newTemp(PrimitiveTypes.int32);

  const isDestructured = Array.isArray(node.variable);
  const isObjectDestructured = !!node.destructureProperties?.length;
  let elementType = isDestructured
    ? ExternTypes.dataList
    : isObjectDestructured
      ? ObjectType
      : (this.getArrayElementType(iterableOperand) ??
        inferredElementType ??
        (node.variableType
          ? this.typeMapper.mapTypeScriptType(node.variableType)
          : PrimitiveTypes.single));

  // If we're iterating an untyped `DataList` (matched by name/udonType), the
  // elements we get are raw `DataToken`s — force the loop variable to be a
  // `DataToken` so copies are well-typed. Only unwrap to concrete element
  // types when we have a `DataListTypeSymbol` carrying elementType info.
  if (isDataList && !(iterableType instanceof DataListTypeSymbol)) {
    elementType = ExternTypes.dataToken;
  }

  let elementVar: TACOperand;
  if (isDestructured) {
    elementVar = this.newTemp(elementType);
  } else {
    const variableName = node.variable as string;
    if (!this.symbolTable.hasInCurrentScope(variableName)) {
      this.symbolTable.addSymbol(variableName, elementType, false, false);
    }
    elementVar = createVariable(variableName, elementType, { isLocal: true });
  }

  this.instructions.push(
    new AssignmentInstruction(
      indexVar,
      createConstant(0, PrimitiveTypes.int32),
    ),
  );
  this.instructions.push(
    new PropertyGetInstruction(
      lengthVar,
      iterableOperand,
      isDataList ? "Count" : "length",
    ),
  );

  const loopStart = this.newLabel("forof_start");
  const loopContinue = this.newLabel("forof_continue");
  const loopEnd = this.newLabel("forof_end");

  this.instructions.push(new LabelInstruction(loopStart));
  const condTemp = this.newTemp(PrimitiveTypes.boolean);
  this.instructions.push(
    new BinaryOpInstruction(condTemp, indexVar, "<", lengthVar),
  );
  this.instructions.push(new ConditionalJumpInstruction(condTemp, loopEnd));

  if (isDataList) {
    const tokenValue = this.newTemp(ExternTypes.dataToken);
    this.instructions.push(
      new MethodCallInstruction(tokenValue, iterableOperand, "get_Item", [
        indexVar,
      ]),
    );
    const resolvedValue =
      iterableType instanceof DataListTypeSymbol &&
      elementType.name !== ExternTypes.dataToken.name
        ? this.unwrapDataToken(tokenValue, elementType)
        : tokenValue;
    this.instructions.push(new CopyInstruction(elementVar, resolvedValue));
  } else {
    this.instructions.push(
      new ArrayAccessInstruction(elementVar, iterableOperand, indexVar),
    );
  }
  if (isDestructured) {
    const names = node.variable as string[];
    // Elements from DataList.get_Item are DataTokens, not generic Objects.
    // Using DataToken type ensures property accesses (e.g., .String, .Float)
    // resolve to the correct extern signatures.
    const destructuredType = isDataList ? ExternTypes.dataToken : ObjectType;
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i];
      if (!this.symbolTable.hasInCurrentScope(name)) {
        this.symbolTable.addSymbol(name, destructuredType, false, false);
      }
      const targetVar = createVariable(name, destructuredType, {
        isLocal: true,
      });
      const elementValue = this.newTemp(destructuredType);
      this.instructions.push(
        new MethodCallInstruction(elementValue, elementVar, "get_Item", [
          createConstant(i, PrimitiveTypes.int32),
        ]),
      );
      this.instructions.push(new CopyInstruction(targetVar, elementValue));
    }
  }
  if (isObjectDestructured && node.destructureProperties) {
    for (const entry of node.destructureProperties) {
      if (!this.symbolTable.hasInCurrentScope(entry.name)) {
        this.symbolTable.addSymbol(entry.name, ObjectType, false, false);
      }
      const targetVar = createVariable(entry.name, ObjectType, {
        isLocal: true,
      });
      const propValue = this.newTemp(ObjectType);
      this.instructions.push(
        new PropertyGetInstruction(propValue, elementVar, entry.property),
      );
      this.instructions.push(new CopyInstruction(targetVar, propValue));
    }
  }
  // Interface dispatch: when element type is an interface with all-inline implementors,
  // generate instanceId-based property copy + classId assignment before the loop body.
  let savedInlineMapBeforeViface:
    | Map<string, { prefix: string; className: string }>
    | undefined;
  let vifacePrefix: string | undefined;
  let vifaceHandleVar: TACOperand | undefined;
  let vifaceInterfaceName: string | undefined;
  let vifaceRelevantInstances: Array<
    [number, { prefix: string; className: string }]
  > = [];
  let vifaceFieldTypes: Map<string, TypeSymbol> | undefined;
  // Helper: get all properties (including inherited) for an implementor.
  // Prefers getMergedProperties (full inheritance chain) over direct node
  // properties, mapping string types to TypeSymbol where needed.
  const getAllClassProps = (
    className: string,
  ): Array<{ name: string; type: TypeSymbol }> => {
    if (this.classRegistry) {
      // Always use getMergedProperties when available — it walks the full
      // inheritance chain. An empty result means the class genuinely has no
      // properties (not that registration is incomplete).
      return this.classRegistry.getMergedProperties(className).map((p) => ({
        name: p.name,
        type: this.typeMapper.mapTypeScriptType(p.type),
      }));
    }
    const classNode = this.classMap.get(className);
    return (
      classNode?.properties.map((p) => ({
        name: p.name,
        type: p.type,
      })) ?? []
    );
  };
  // Note: this closure may be called multiple times at compile time — once
  // per early-exit path (return/throw via emitLoopExitEpilogues) and once
  // per finalize trampoline (continue/break). Each call emits its own copy
  // of the write-back instructions because they belong to different runtime
  // control-flow paths. Copies on unreachable paths (e.g. finalize labels
  // after a return) are harmless dead code at runtime, pruned when the
  // optimizer is enabled (optimize: true).
  const emitVirtualInterfaceIterationEpilogue = (
    targetLabel?: TACOperand,
  ): void => {
    if (
      vifacePrefix &&
      vifaceHandleVar &&
      vifaceInterfaceName &&
      vifaceRelevantInstances.length > 0
    ) {
      const writebackEndLabel = this.newLabel("viface_wb_end");
      for (const [instanceId, info] of vifaceRelevantInstances) {
        const nextLabel = this.newLabel("viface_wb_next");
        const cond = this.newTemp(PrimitiveTypes.boolean);
        this.instructions.push(
          new BinaryOpInstruction(
            cond,
            vifaceHandleVar,
            "==",
            createConstant(instanceId, PrimitiveTypes.int32),
          ),
        );
        this.instructions.push(new ConditionalJumpInstruction(cond, nextLabel));

        // Use getAllClassProps to include inherited properties in write-back.
        const propsToWriteBack = getAllClassProps(info.className);
        for (const prop of propsToWriteBack) {
          const vifaceType = vifaceFieldTypes?.get(prop.name) ?? prop.type;
          const src = createVariable(
            `${vifacePrefix}_${prop.name}`,
            vifaceType,
          );
          const dst = createVariable(`${info.prefix}_${prop.name}`, prop.type);
          this.instructions.push(new CopyInstruction(dst, src));
          this.maybeTrackInlineInstanceAssignment(dst, src);
        }

        this.instructions.push(
          new UnconditionalJumpInstruction(writebackEndLabel),
        );
        this.instructions.push(new LabelInstruction(nextLabel));
      }
      this.instructions.push(new LabelInstruction(writebackEndLabel));
    }

    // Restore inlineInstanceMap: remove entries pointing to the virtual prefix.
    // Temporaries mapped to vifacePrefix during the loop body (e.g. method
    // return values that resolved to `this` inside the inlined body) are also
    // cleaned up here — they didn't exist before viface setup so they are
    // deleted. After restoration, any reference through those temporaries
    // will fall through to the generic EXTERN path, which is safe.
    if (vifacePrefix && savedInlineMapBeforeViface) {
      const mappedToViface = Array.from(this.inlineInstanceMap.entries())
        .filter(([, entry]) => entry.prefix === vifacePrefix)
        .map(([name]) => name);
      for (const name of mappedToViface) {
        const previous = savedInlineMapBeforeViface.get(name);
        if (previous) {
          this.inlineInstanceMap.set(name, previous);
        } else {
          this.inlineInstanceMap.delete(name);
        }
      }
    }

    if (targetLabel) {
      this.instructions.push(new UnconditionalJumpInstruction(targetLabel));
    }
  };

  if (
    !isDestructured &&
    !isObjectDestructured &&
    typeof node.variable === "string"
  ) {
    const variableName = node.variable;
    const ifaceName = elementType.name;
    // Early guard: only attempt viface dispatch for registered interfaces
    const ifaceMeta = this.classRegistry?.getInterface(ifaceName);
    if (ifaceMeta && isAllInlineInterface(this, ifaceName)) {
      // Collect all inline instances that implement this interface.
      // NOTE: allInlineInstances is compilation-unit-wide, so instances that
      // are never stored in *this* array (e.g. a scalar IYaku field in another
      // class) will still generate dispatch branches. This is an intentional
      // over-approximation that avoids costly data-flow analysis. The extra
      // branches are dead at runtime and will be pruned by the optimizer.
      const implementors =
        this.classRegistry?.getImplementorsOfInterface(ifaceName) ?? [];
      const implementorNames = new Set(implementors.map((impl) => impl.name));
      const classIds = this.interfaceClassIdMap.get(ifaceName);
      if (!classIds) {
        // classIds is populated lazily by visitInlineConstructor. If the
        // for-of loop appears before any constructor call for this
        // interface's implementors, the dispatch cannot be generated and
        // method calls would silently become no-ops at runtime. Fail hard.
        throw new Error(
          `Interface "${ifaceName}" has all-inline implementors but no classId map was found. ` +
            `Inline constructors must be visited before the for-of loop.`,
        );
      }
      // ifaceMeta and classIds are guaranteed non-null here (guarded by the
      // outer ifaceMeta check at line 624 and the throw at line 640).
      const relevantInstances: Array<
        [number, { prefix: string; className: string }]
      > = [];
      for (const [id, info] of this.allInlineInstances) {
        if (implementorNames.has(info.className)) {
          relevantInstances.push([id, info]);
        }
      }

      // Only emit dispatch when there are known instances to dispatch to.
      // ifaceMeta and classIds are guaranteed non-null here (guarded by the
      // throw above and the outer ifaceMeta check at line 624).
      if (relevantInstances.length === 0) {
        // classIds exists (constructors were visited) but no instances found
        // in allInlineInstances — indicates a registration mismatch.
        throw new Error(
          `Interface "${ifaceName}" has classIds but no relevant inline instances. ` +
            `Check that allInlineInstances is populated before the for-of loop.`,
        );
      }
      // instanceCounter is shared with concrete instances (__inst_*) — the
      // __viface_ prefix prevents name collisions while keeping IDs unique.
      const virtualPrefix = `__viface_${ifaceName}_${this.instanceCounter++}`;
      const classIdVar = createVariable(
        `${virtualPrefix}__classId`,
        PrimitiveTypes.int32,
      );
      const dispatchEndLabel = this.newLabel("viface_end");

      // Build a unified type map for virtual-prefix variables: when
      // implementors declare the same private field name with different
      // types, fall back to ObjectType so the TAC remains type-consistent.
      vifaceFieldTypes = new Map<string, TypeSymbol>();
      for (const [, info] of relevantInstances) {
        const props = getAllClassProps(info.className);
        for (const prop of props) {
          const existing = vifaceFieldTypes.get(prop.name);
          if (!existing) {
            vifaceFieldTypes.set(prop.name, prop.type);
          } else if (existing.name !== prop.type.name) {
            vifaceFieldTypes.set(prop.name, ObjectType);
          }
        }
      }

      // elementVar is Object (from array access); copy to Int32 for comparison
      const handleVar = this.newTemp(PrimitiveTypes.int32);
      this.instructions.push(new CopyInstruction(handleVar, elementVar));

      // Reset classId to sentinel so an unmatched instanceId doesn't
      // silently reuse the previous iteration's stale value.
      this.instructions.push(
        new AssignmentInstruction(
          classIdVar,
          createConstant(-1, PrimitiveTypes.int32),
        ),
      );

      // Generate instanceId-based if-else dispatch
      for (const [instanceId, info] of relevantInstances) {
        const nextLabel = this.newLabel("viface_next");
        const cond = this.newTemp(PrimitiveTypes.boolean);
        this.instructions.push(
          new BinaryOpInstruction(
            cond,
            handleVar,
            "==",
            createConstant(instanceId, PrimitiveTypes.int32),
          ),
        );
        this.instructions.push(new ConditionalJumpInstruction(cond, nextLabel));

        // Copy all class properties (including inherited) to virtual variables
        // so inlined method bodies can access private/internal/inherited fields.
        // Virtual variable types are unified via vifaceFieldTypes above.
        const propsToCopy = getAllClassProps(info.className);
        for (const prop of propsToCopy) {
          const vifaceType = vifaceFieldTypes.get(prop.name) ?? prop.type;
          const src = createVariable(`${info.prefix}_${prop.name}`, prop.type);
          const dst = createVariable(
            `${virtualPrefix}_${prop.name}`,
            vifaceType,
          );
          this.instructions.push(new CopyInstruction(dst, src));
          this.maybeTrackInlineInstanceAssignment(dst, src);
        }

        // Set classId
        // classId should always be defined: every class in allInlineInstances
        // went through visitInlineConstructor, which populates interfaceClassIdMap.
        const classId = classIds.get(info.className);
        if (classId === undefined) {
          throw new Error(
            `[viface dispatch] classId missing for "${info.className}" in interface "${ifaceName}". ` +
              `This indicates a mismatch between allInlineInstances and interfaceClassIdMap.`,
          );
        }
        this.instructions.push(
          new AssignmentInstruction(
            classIdVar,
            createConstant(classId, PrimitiveTypes.int32),
          ),
        );

        this.instructions.push(
          new UnconditionalJumpInstruction(dispatchEndLabel),
        );
        this.instructions.push(new LabelInstruction(nextLabel));
      }
      this.instructions.push(new LabelInstruction(dispatchEndLabel));

      // Register virtual prefix in inlineInstanceMap for the loop variable
      savedInlineMapBeforeViface = new Map(this.inlineInstanceMap);
      this.inlineInstanceMap.set(variableName, {
        prefix: virtualPrefix,
        className: ifaceName,
      });

      vifacePrefix = virtualPrefix;
      vifaceHandleVar = handleVar;
      vifaceInterfaceName = ifaceName;
      vifaceRelevantInstances = relevantInstances;
    }
  }

  // Only introduce finalize labels when viface dispatch is active.
  // Otherwise use the original direct break/continue targets to avoid
  // extra trampoline jumps on every non-interface for-of loop.
  // Note: all throws above this point occur before loopContextStack.push(),
  // so the stack is clean if they fire. The push below is the first
  // mutation that requires a pop (handled by the try/finally).
  const needsVifaceEpilogue = !!vifacePrefix;
  if (needsVifaceEpilogue) {
    const loopFinalizeContinue = this.newLabel("forof_finalize_continue");
    const loopFinalizeBreak = this.newLabel("forof_finalize_break");
    this.loopContextStack.push({
      breakLabel: loopFinalizeBreak,
      continueLabel: loopFinalizeContinue,
      // Contract: emitExitEpilogue emits write-back instructions but does
      // NOT emit a trailing jump. Callers must emit their own control-flow
      // instruction immediately after. Exhaustive call sites:
      //   - visitReturnStatement → emitLoopExitEpilogues → then ReturnInstruction
      //   - visitReturnStatement (inline) → emitLoopExitEpiloguesSinceDepth → then jump to returnLabel
      //   - visitThrowStatement (no try) → emitLoopExitEpilogues → then ReturnInstruction
      //   - visitThrowStatement (inline, no try) → emitLoopExitEpiloguesSinceDepth → then jump to returnLabel
      //   - visitThrowStatement (try) → emitLoopExitEpiloguesSinceDepth → then jump to errorTarget
      emitExitEpilogue: () => emitVirtualInterfaceIterationEpilogue(),
    });

    try {
      this.visitStatement(node.body);
    } finally {
      // Ensure the loop context is popped even if visitStatement throws
      // (e.g. CompileError for unsupported syntax inside the loop body),
      // preventing a stale entry from corrupting the stack.
      this.loopContextStack.pop();
    }

    // Control-flow topology:
    //   loopFinalizeContinue — reached by normal fall-through and `continue`.
    //     Emits write-back, then jumps to loopContinue (index increment).
    //   loopFinalizeBreak — reached ONLY via `break` (not from fall-through).
    //     Emits write-back, then jumps to loopEnd.
    // The two labels are sequential in TAC but represent disjoint runtime paths.
    this.instructions.push(new LabelInstruction(loopFinalizeContinue));
    emitVirtualInterfaceIterationEpilogue(loopContinue);

    this.instructions.push(new LabelInstruction(loopFinalizeBreak));
    emitVirtualInterfaceIterationEpilogue(loopEnd);
  } else {
    this.loopContextStack.push({
      breakLabel: loopEnd,
      continueLabel: loopContinue,
    });

    try {
      this.visitStatement(node.body);
    } finally {
      this.loopContextStack.pop();
    }
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
}

export function visitSwitchStatement(
  this: ASTToTACConverter,
  node: SwitchStatementNode,
): void {
  const endLabel = this.newLabel("switch_end");
  const switchValue = this.visitExpression(node.expression);
  const switchType = this.getOperandType(switchValue);
  const switchTemp = this.newTemp(switchType);
  this.instructions.push(new CopyInstruction(switchTemp, switchValue));
  const caseEntries = node.cases.map((caseNode) => ({
    node: caseNode,
    label: this.newLabel("switch_case"),
  }));

  for (const entry of caseEntries) {
    if (!entry.node.expression) continue;
    const rawCaseValue = this.visitExpression(entry.node.expression);
    const caseValue = this.coerceSwitchOperand(rawCaseValue, switchType);
    const comparisonResult = this.newTemp(PrimitiveTypes.boolean);
    // Use "!=" because ConditionalJump jumps when the condition is false,
    // so we branch to the case label when values are equal.
    this.instructions.push(
      new BinaryOpInstruction(comparisonResult, switchTemp, "!=", caseValue),
    );
    this.instructions.push(
      new ConditionalJumpInstruction(comparisonResult, entry.label),
    );
  }

  const defaultEntry = caseEntries.find(
    (entry) => entry.node.expression === null,
  );
  this.instructions.push(
    new UnconditionalJumpInstruction(defaultEntry?.label ?? endLabel),
  );

  const outerContext = this.loopContextStack[this.loopContextStack.length - 1];
  // Note: emitExitEpilogue is intentionally NOT forwarded from the outer loop.
  // Switch `break` jumps to endLabel (below), which is still inside the loop
  // body. Execution then falls through to the loop's finalize trampoline
  // (loopFinalizeContinue/Break) where viface write-back runs normally.
  // `continue` IS forwarded via outerContext.continueLabel so it correctly
  // reaches the loop's finalize trampoline.
  this.loopContextStack.push({
    breakLabel: endLabel,
    continueLabel: outerContext?.continueLabel ?? endLabel,
  });

  for (const entry of caseEntries) {
    this.instructions.push(new LabelInstruction(entry.label));
    for (const statement of entry.node.statements) {
      this.visitStatement(statement);
    }
  }

  this.loopContextStack.pop();
  this.instructions.push(new LabelInstruction(endLabel));
}

export function visitDoWhileStatement(
  this: ASTToTACConverter,
  node: DoWhileStatementNode,
): void {
  const startLabel = this.newLabel("do_start");
  const conditionLabel = this.newLabel("do_condition");
  const endLabel = this.newLabel("do_end");

  this.instructions.push(new LabelInstruction(startLabel));

  this.loopContextStack.push({
    breakLabel: endLabel,
    continueLabel: conditionLabel,
  });
  this.visitStatement(node.body);
  this.loopContextStack.pop();

  this.instructions.push(new LabelInstruction(conditionLabel));
  const condition = this.visitExpression(node.condition);
  this.instructions.push(new ConditionalJumpInstruction(condition, endLabel));
  this.instructions.push(new UnconditionalJumpInstruction(startLabel));
  this.instructions.push(new LabelInstruction(endLabel));
}

export function visitBreakStatement(
  this: ASTToTACConverter,
  _node: BreakStatementNode,
): void {
  const context = this.loopContextStack[this.loopContextStack.length - 1];
  if (!context) {
    throw new Error("Break statement used outside of loop or switch");
  }
  this.instructions.push(new UnconditionalJumpInstruction(context.breakLabel));
}

export function visitContinueStatement(
  this: ASTToTACConverter,
  _node: ContinueStatementNode,
): void {
  const context = this.loopContextStack[this.loopContextStack.length - 1];
  if (!context) {
    throw new Error("Continue statement used outside of loop");
  }
  this.instructions.push(
    new UnconditionalJumpInstruction(context.continueLabel),
  );
}

export function visitReturnStatement(
  this: ASTToTACConverter,
  node: ReturnStatementNode,
): void {
  const value = node.value ? this.visitExpression(node.value) : undefined;

  // Check inlineReturnStack FIRST: if we are inside an inlined method body,
  // return must go to the inline return label, not the recursive dispatch.
  // currentRecursiveContext remains set from the enclosing recursive method
  // during inlining, so checking it first would incorrectly decrement depth
  // and jump to the dispatch table.
  const inlineContext =
    this.inlineReturnStack[this.inlineReturnStack.length - 1];

  if (
    !inlineContext &&
    this.currentRecursiveContext &&
    this.currentMethodName
  ) {
    // value is evaluated before the epilogue runs. If it references a viface
    // variable, the TAC operand still holds the viface name — but the data is
    // correct because write-back copies viface→concrete without clearing the
    // viface heap slot. tempValue is a fresh temp with no inlineInstanceMap
    // entry, so stale inline tracking is not a concern here.
    // Note: emitLoopExitEpilogues (no depth guard) is correct here because
    // recursive methods are compiled as a unit — loopContextStack only
    // contains loops from this method body, not from outer call sites.
    emitLoopExitEpilogues(this);
    const tempValue = value
      ? this.newTemp(this.getOperandType(value))
      : undefined;
    if (tempValue && value) {
      this.instructions.push(new CopyInstruction(tempValue, value));
    }
    // Copy return value to the return export variable before epilogue
    if (tempValue && this.currentReturnVar) {
      const returnVar = createVariable(
        this.currentReturnVar,
        this.getOperandType(tempValue),
      );
      this.instructions.push(new CopyInstruction(returnVar, tempValue));
    }
    // Decrement depth and jump to dispatch.
    // dispatchLabel is always set when currentRecursiveContext is created,
    // so this block is guaranteed to execute fully (decrement + jump).
    {
      const { dispatchLabel } = this.currentRecursiveContext;
      const depthVar = createVariable(
        this.currentRecursiveContext.depthVar,
        PrimitiveTypes.int32,
      );
      const depthTemp = this.newTemp(PrimitiveTypes.int32);
      this.instructions.push(
        new BinaryOpInstruction(
          depthTemp,
          depthVar,
          "-",
          createConstant(1, PrimitiveTypes.int32),
        ),
      );
      this.instructions.push(new CopyInstruction(depthVar, depthTemp));
      this.instructions.push(new UnconditionalJumpInstruction(dispatchLabel));
    }
    return;
  }
  if (inlineContext) {
    emitLoopExitEpiloguesSinceDepth(this, inlineContext.loopDepth);
    // Capture valueMapping AFTER the epilogue so inlineInstanceMap reflects
    // the post-loop state (viface entries are restored/removed by the epilogue).
    const valueMapping =
      value?.kind === TACOperandKind.Variable
        ? this.inlineInstanceMap.get((value as VariableOperand).name)
        : undefined;
    if (value) {
      this.instructions.push(
        new CopyInstruction(inlineContext.returnVar, value),
      );
      if (!inlineContext.returnTrackingInvalidated) {
        if (valueMapping) {
          const existingMapping = this.inlineInstanceMap.get(
            inlineContext.returnVar.name,
          );
          if (existingMapping && existingMapping !== valueMapping) {
            this.inlineInstanceMap.delete(inlineContext.returnVar.name);
            inlineContext.returnTrackingInvalidated = true;
          } else {
            this.inlineInstanceMap.set(
              inlineContext.returnVar.name,
              valueMapping,
            );
          }
        } else {
          this.inlineInstanceMap.delete(inlineContext.returnVar.name);
          inlineContext.returnTrackingInvalidated = true;
        }
      }
    } else if (!inlineContext.returnTrackingInvalidated) {
      this.inlineInstanceMap.delete(inlineContext.returnVar.name);
      inlineContext.returnTrackingInvalidated = true;
    }
    this.instructions.push(
      new UnconditionalJumpInstruction(inlineContext.returnLabel),
    );
    return;
  }
  emitLoopExitEpilogues(this);
  this.instructions.push(new ReturnInstruction(value, this.currentReturnVar));
}

export function visitBlockStatement(
  this: ASTToTACConverter,
  node: BlockStatementNode,
): void {
  this.symbolTable.enterScope();
  this.scanDeclarations(node.statements);
  for (const statement of node.statements) {
    this.visitStatement(statement);
  }
  this.symbolTable.exitScope();
}

export function visitInlineBlockStatement(
  this: ASTToTACConverter,
  node: BlockStatementNode,
): void {
  for (const statement of node.statements) {
    this.visitStatement(statement);
  }
}

export function visitClassDeclaration(
  this: ASTToTACConverter,
  node: ClassDeclarationNode,
): void {
  this.currentClassName = node.name;
  const classLayout = this.getUdonBehaviourLayout(node.name);
  const isUdonBehaviourClass =
    classLayout !== null ||
    node.decorators.some((decorator) => decorator.name === "UdonBehaviour");
  // Process non-recursive methods before recursive ones so that all
  // external caller return sites are registered in recursiveReturnSites
  // BEFORE any recursive method's dispatch table is emitted.
  // Within the non-recursive group, Start is placed first (it contains
  // property initialization and top-level const setup).
  const nonRecursive = node.methods.filter((m) => !m.isRecursive);
  const recursive = node.methods.filter((m) => m.isRecursive);
  const startIndex = nonRecursive.findIndex((m) => m.name === "Start");
  if (startIndex > 0) {
    const [start] = nonRecursive.splice(startIndex, 1);
    nonRecursive.unshift(start);
  }
  const orderedMethods = [...nonRecursive, ...recursive];
  for (const method of orderedMethods) {
    this.currentMethodName = method.name;
    const eventDef = getVrcEventDefinition(method.name);
    let labelName = eventDef
      ? eventDef.udonName
      : `__${method.name}_${node.name}`;
    if (method.name === "Start") {
      labelName = "_start";
    }
    if (isUdonBehaviourClass && method.name !== "Start") {
      const layout = classLayout?.get(method.name) ?? null;
      if (layout) {
        labelName = layout.exportMethodName;
        this.currentMethodLayout = layout;
      } else {
        this.currentMethodLayout = null;
      }
    } else {
      this.currentMethodLayout = null;
    }
    const label = createLabel(labelName);
    this.instructions.push(new LabelInstruction(label));

    if (this.currentMethodLayout?.returnExportName) {
      this.currentReturnVar = this.currentMethodLayout.returnExportName;
    } else {
      this.currentReturnVar = "__returnValue_return";
    }
    this.symbolTable.enterScope();
    this.currentParamExportMap = new Map();
    this.currentParamExportReverseMap = new Map();
    let recursionContext:
      | {
          locals: Array<{ name: string; type: TypeSymbol }>;
          depthVar: string;
          spVar: string;
          stackVars: Array<{ name: string; type: TypeSymbol }>;
          returnSites: Array<{ index: number; labelName: string }>;
          nextSelfCallResultIndex?: number;
          dispatchLabel: TACOperand;
          overflowLabel: TACOperand;
        }
      | undefined;
    if (eventDef) {
      for (const param of eventDef.parameters) {
        if (!this.symbolTable.hasInCurrentScope(param.name)) {
          this.symbolTable.addSymbol(
            param.name,
            this.typeMapper.mapUdonType(param.type),
            true,
            false,
          );
        }
      }
    }
    for (const param of method.parameters) {
      if (!this.symbolTable.hasInCurrentScope(param.name)) {
        this.symbolTable.addSymbol(param.name, param.type, true, false);
      }
    }
    if (this.currentMethodLayout) {
      for (let i = 0; i < method.parameters.length; i++) {
        const paramName = method.parameters[i]?.name;
        const exportName = this.currentMethodLayout.parameterExportNames[i];
        if (paramName && exportName) {
          this.currentParamExportMap.set(paramName, exportName);
          this.currentParamExportReverseMap.set(exportName, paramName);
        }
      }
    }

    let expectedSelfCallCount: number | undefined;
    let expectedTryCatchCount: number | undefined;
    let tryCounterBeforeMethod: number | undefined;
    let hasReturnExport = false;
    let earlyInitDone = false;
    if (method.isRecursive) {
      const selfCallCount = countSelfCalls(method.name, method.body);
      expectedSelfCallCount = selfCallCount;
      console.info(
        `transpiler: @RecursiveMethod ${node.name}.${method.name} — ` +
          `max recursion depth is ${MAX_RECURSION_STACK_DEPTH}. ` +
          "Exceeding this limit will silently abort the active event handler.",
      );

      // KNOWN LIMITATION: Only user-declared variables (parameters, let/const,
      // for-of loop vars, catch vars) are saved/restored across self-call
      // boundaries. Compiler-generated temporaries (__t_*) are NOT included
      // in the push/pop set. This means sub-expressions evaluated BEFORE a
      // self-call that are used AFTER it may be silently corrupted.
      // Example: `(n + 1) * this.factorial(n - 1)` — the temp for `(n + 1)`
      // will be overwritten by the callee. Workaround: assign sub-expressions
      // to local variables before self-calls:
      //   const left = n + 1;
      //   return left * this.factorial(n - 1);
      // A full fix would require liveness analysis to identify temps that are
      // live across self-call boundaries and include them in the push/pop set.
      const locals = this.collectRecursiveLocals(method);
      // Remap parameter names to their export names (e.g., "n" → "__0_n__param")
      // because the method body uses export names, not local names
      for (const local of locals) {
        const exportName = this.currentParamExportMap.get(local.name);
        if (exportName) {
          local.name = exportName;
        }
      }
      // Add __returnSiteIdx to the recursion stack locals.
      const returnSiteIdxVarName = `__returnSiteIdx_${node.name}_${method.name}`;
      locals.push({
        name: returnSiteIdxVarName,
        type: PrimitiveTypes.int32,
      });
      // Add return export variable to the recursion stack locals
      // so it gets saved/restored at each call site.
      const layout = this.udonBehaviourLayouts
        ?.get(node.name)
        ?.get(method.name);
      hasReturnExport = !!layout?.returnExportName;
      if (layout?.returnExportName) {
        locals.push({
          name: layout.returnExportName,
          type: layout.returnType,
        });
      }
      // Add self-call result variables that survive across sibling calls.
      // Each self-call site captures the return value into a named variable
      // that is part of the push/pop set, ensuring results survive when
      // a sibling call re-enters the method body.
      for (let i = 0; i < selfCallCount; i++) {
        if (layout?.returnExportName) {
          locals.push({
            name: `__selfCallResult_${node.name}_${method.name}_${i}`,
            type: layout.returnType ?? PrimitiveTypes.single,
          });
        }
      }
      // Emit property/constructor initialization and top-level const injection
      // BEFORE the recursion prologue, so that this.tryCounter reflects any
      // try/catch blocks emitted by property initializers. This ensures the
      // predicted __error_flag/value variable IDs match the actual IDs assigned
      // during method body traversal.
      if (
        method.name === "Start" &&
        this.pendingTopLevelInits.length > 0 &&
        this.entryPointClasses.has(node.name)
      ) {
        for (const tlc of this.pendingTopLevelInits) {
          this.visitVariableDeclaration(tlc);
        }
        this.pendingTopLevelInits = [];
      }
      if (method.name === "Start" && this.entryPointClasses.has(node.name)) {
        this.emitEntryPointPropertyInit(node);
      }
      earlyInitDone = true;

      // Now predict try/catch variable names using the updated tryCounter.
      expectedTryCatchCount = countTryCatchBlocks(method.body);
      tryCounterBeforeMethod = this.tryCounter;
      for (let i = 0; i < expectedTryCatchCount; i++) {
        const tryId = this.tryCounter + i;
        locals.push({
          name: `__error_flag_${tryId}`,
          type: PrimitiveTypes.boolean,
        });
        locals.push({
          name: `__error_value_${tryId}`,
          type: ObjectType,
        });
      }

      const depthVar = `__recursionDepth_${node.name}_${method.name}`;
      const spVar = `__recursionSP_${node.name}_${method.name}`;
      const stackVars = locals.map((local) => ({
        name: `__recursionStack_${node.name}_${method.name}_${local.name}`,
        type: ExternTypes.dataList as TypeSymbol,
      }));

      recursionContext = {
        locals,
        depthVar,
        spVar,
        stackVars,
        returnSites: [],
        nextSelfCallResultIndex: 0,
        dispatchLabel: this.newLabel("recursive_dispatch"),
        overflowLabel: this.newLabel("recursion_overflow"),
      };
      this.currentRecursiveContext = recursionContext;

      // Allocate recursion stack DataLists once (first invocation only).
      // Uses a boolean flag instead of depth==0 check to avoid re-allocating
      // on every external call (which sets depth to 0 before jumping).
      const stackInitFlagName = `__stackInitialized_${node.name}_${method.name}`;
      const stackInitFlag = createVariable(
        stackInitFlagName,
        PrimitiveTypes.boolean,
      );
      // notInitialized = !stackInitFlag
      // ConditionalJump is "ifFalse goto": jumps when notInitialized is FALSE
      // (i.e., already initialized) → skips allocation. Falls through when TRUE
      // (not initialized) → runs allocation.
      const notInitialized = this.newTemp(PrimitiveTypes.boolean);
      this.instructions.push(
        new BinaryOpInstruction(
          notInitialized,
          stackInitFlag,
          "==",
          createConstant(false, PrimitiveTypes.boolean),
        ),
      );
      const skipAllocLabel = this.newLabel("skip_stack_alloc");
      this.instructions.push(
        new ConditionalJumpInstruction(notInitialized, skipAllocLabel),
      );

      {
        // Mark as initialized
        this.instructions.push(
          new CopyInstruction(
            stackInitFlag,
            createConstant(true, PrimitiveTypes.boolean),
          ),
        );
        const maxRecursionDepth = MAX_RECURSION_STACK_DEPTH;
        // Default token is Single-typed regardless of each stack's actual local type.
        // This is safe because emitCallSitePush always overwrites slots via set_Item
        // before emitCallSitePop reads them; the defaults are never consumed at runtime.
        const defaultToken = this.wrapDataToken(
          createConstant(0, PrimitiveTypes.single),
        );
        for (const stackVarInfo of stackVars) {
          const stackVar = createVariable(
            stackVarInfo.name,
            ExternTypes.dataList,
          );
          const externSig = this.requireExternSignature(
            "DataList",
            "ctor",
            "method",
            [],
            "DataList",
          );
          this.instructions.push(new CallInstruction(stackVar, externSig, []));
          // Pre-populate with default tokens for indexed set_Item access
          for (let i = 0; i < maxRecursionDepth; i++) {
            this.instructions.push(
              new MethodCallInstruction(undefined, stackVar, "Add", [
                defaultToken,
              ]),
            );
          }
        }
        // Note: returnSiteIdx is NOT initialized here because the caller
        // always sets it before JUMP. The dispatch table's fallback
        // (JUMP 0xFFFFFFFC) handles any unmatched index defensively.
      }
      this.instructions.push(new LabelInstruction(skipAllocLabel));
      // Always reset SP to -1 at top-level entry (both first and subsequent calls).
      // Uses depth <= 0 to cover both the heap-initialized state (depth == 0)
      // and the post-completion state (depth == -1) left after a compiled caller's
      // invocation, which decrements depth before returning to the dispatch table.
      // This ensures SendCustomEvent and other non-compiled callers reset SP correctly.
      {
        const depthVarOp = createVariable(depthVar, PrimitiveTypes.int32);
        const depthAtTopLevel = this.newTemp(PrimitiveTypes.boolean);
        this.instructions.push(
          new BinaryOpInstruction(
            depthAtTopLevel,
            depthVarOp,
            "<=",
            createConstant(0, PrimitiveTypes.int32),
          ),
        );
        const skipSpResetLabel = this.newLabel("skip_sp_reset");
        this.instructions.push(
          new ConditionalJumpInstruction(depthAtTopLevel, skipSpResetLabel),
        );
        const spVarOp = createVariable(spVar, PrimitiveTypes.int32);
        this.instructions.push(
          new CopyInstruction(
            spVarOp,
            createConstant(-1, PrimitiveTypes.int32),
          ),
        );
        // Also reset depth to 0 to normalize the post-completion -1 state.
        // Without this, depth stays at -1, and the first self-call increments
        // it to 0, causing the SP reset to fire again on re-entry.
        this.instructions.push(
          new CopyInstruction(
            depthVarOp,
            createConstant(0, PrimitiveTypes.int32),
          ),
        );
        this.instructions.push(new LabelInstruction(skipSpResetLabel));
      }
      // Shared overflow handler: emitted once per method, jumped to from each
      // call site's depth check in emitCallSitePush.
      // Placed here (before body traversal) so the normal execution path jumps
      // past it. Uses JUMP 0xFFFFFFFC (ReturnInstruction) which exits the
      // entire active event handler.
      {
        const afterOverflowLabel = this.newLabel("after_overflow");
        this.instructions.push(
          new UnconditionalJumpInstruction(afterOverflowLabel),
        );
        this.instructions.push(
          new LabelInstruction(recursionContext.overflowLabel),
        );
        const logErrorExtern = this.requireExternSignature(
          "Debug",
          "LogError",
          "method",
          ["object"],
          "void",
        );
        const overflowMsg = createConstant(
          `[udon-assembly-ts] Max recursion depth (${MAX_RECURSION_STACK_DEPTH}) exceeded in ${node.name}.${method.name}. Aborting event handler.`,
          PrimitiveTypes.string,
        );
        this.instructions.push(
          new CallInstruction(undefined, logErrorExtern, [overflowMsg]),
        );
        // Reset depth to 0 so a subsequent SendCustomEvent invocation
        // triggers SP reset at method entry and can call this method again.
        const overflowDepthVar = createVariable(depthVar, PrimitiveTypes.int32);
        this.instructions.push(
          new CopyInstruction(
            overflowDepthVar,
            createConstant(0, PrimitiveTypes.int32),
          ),
        );
        this.instructions.push(
          new ReturnInstruction(undefined, this.currentReturnVar),
        );
        this.instructions.push(new LabelInstruction(afterOverflowLabel));
      }
    }

    // Inject non-literal top-level const initialization at the start of _start/Start
    // Only for entry-point classes whose Start becomes the actual _start label.
    // Skip if already done in the recursive method prologue (earlyInitDone).
    if (
      !earlyInitDone &&
      method.name === "Start" &&
      this.pendingTopLevelInits.length > 0 &&
      this.entryPointClasses.has(node.name)
    ) {
      for (const tlc of this.pendingTopLevelInits) {
        this.visitVariableDeclaration(tlc);
      }
      this.pendingTopLevelInits = [];
    }

    // Entry-point class property initialization + constructor body in _start/Start.
    // Skip if already done in the recursive method prologue (earlyInitDone).
    if (
      !earlyInitDone &&
      method.name === "Start" &&
      this.entryPointClasses.has(node.name)
    ) {
      this.emitEntryPointPropertyInit(node);
    }

    // Capture tryCounter immediately before body traversal.
    // For recursive methods, tryCounterBeforeMethod is already captured
    // in the prologue (after earlyInit). For non-recursive methods, capture here.
    if (tryCounterBeforeMethod === undefined) {
      tryCounterBeforeMethod = this.tryCounter;
    }
    this.visitBlockStatement(method.body);
    // Assert that countSelfCalls and code-gen agree on the number of self-calls.
    // Only meaningful for entry-point classes where JUMP-based dispatch is used
    // AND the method has a return value (nextSelfCallResultIndex is only
    // incremented when layout.returnExportName is truthy).
    if (
      expectedSelfCallCount !== undefined &&
      this.currentRecursiveContext?.nextSelfCallResultIndex !== undefined &&
      this.entryPointClasses.has(node.name) &&
      hasReturnExport
    ) {
      const emitted = this.currentRecursiveContext.nextSelfCallResultIndex;
      if (emitted > expectedSelfCallCount) {
        // Hard error: the extra __selfCallResult_* variables (indices >=
        // expectedSelfCallCount) are NOT in the push/pop set, so they would
        // be silently overwritten by deeper recursive frames. This typically
        // happens when a self-call appears inside an inlined forEach callback.
        throw new Error(
          `countSelfCalls returned ${expectedSelfCallCount} but ` +
            `code-gen emitted ${emitted} self-call sites for ${node.name}.${method.name}. ` +
            "Self-calls inside forEach callbacks within @RecursiveMethod are not supported. " +
            "Workaround: extract the forEach body into a separate non-recursive helper method.",
        );
      }
      if (emitted < expectedSelfCallCount) {
        // Warn-only (not error): over-counted variables are added to the
        // push/pop set but never written or read by code-gen. They are
        // push/pop-balanced by construction, so correctness is preserved —
        // the only cost is slightly more stack save/restore overhead.
        console.warn(
          `[WARN] countSelfCalls over-counted: expected ${expectedSelfCallCount} ` +
            `but emitted ${emitted} self-call sites for ${node.name}.${method.name}. ` +
            "Extra __selfCallResult_* variables waste stack space.",
        );
      }
    }
    // Verify that countTryCatchBlocks predicted the correct number of try/catch blocks.
    if (
      expectedTryCatchCount !== undefined &&
      tryCounterBeforeMethod !== undefined
    ) {
      const actualTryCatchCount = this.tryCounter - tryCounterBeforeMethod;
      if (actualTryCatchCount !== expectedTryCatchCount) {
        // Hard throw is intentional: the predicted __error_flag/value variables
        // would be missing from the recursion stack, causing silent state
        // corruption across self-call boundaries.
        throw new Error(
          `countTryCatchBlocks returned ${expectedTryCatchCount} but ` +
            `code-gen emitted ${actualTryCatchCount} try/catch blocks ` +
            `for ${node.name}.${method.name}. ` +
            "Using try/catch inside forEach callbacks within @RecursiveMethod is not supported. " +
            "Workaround: extract the try/catch body into a separate non-recursive helper method.",
        );
      }
    }
    if (this.currentRecursiveContext) {
      // Method-end fallthrough: decrement depth to match early-return behavior.
      // Well-formed recursive methods always have explicit return statements,
      // so this path is typically unreachable (all returns go through
      // visitReturnStatement which decrements depth before dispatch).
      // However, for defensive correctness we emit the decrement anyway.
      {
        const depthVarEnd = createVariable(
          this.currentRecursiveContext.depthVar,
          PrimitiveTypes.int32,
        );
        const depthTmpEnd = this.newTemp(PrimitiveTypes.int32);
        this.instructions.push(
          new BinaryOpInstruction(
            depthTmpEnd,
            depthVarEnd,
            "-",
            createConstant(1, PrimitiveTypes.int32),
          ),
        );
        this.instructions.push(new CopyInstruction(depthVarEnd, depthTmpEnd));
      }
      // Jump to dispatch (dispatch uses current siteIdx)
      if (this.currentRecursiveContext.dispatchLabel) {
        this.instructions.push(
          new UnconditionalJumpInstruction(
            this.currentRecursiveContext.dispatchLabel,
          ),
        );
      }
      // Shared dispatch label: all return paths jump here.
      // The registry is fully populated at this point because all
      // non-recursive methods are compiled first (see orderedMethods above),
      // so all external caller return sites are already registered.
      if (this.currentRecursiveContext.dispatchLabel) {
        this.instructions.push(
          new LabelInstruction(this.currentRecursiveContext.dispatchLabel),
        );
      }
      this.emitReturnSiteDispatch();
    } else {
      this.instructions.push(
        new ReturnInstruction(undefined, this.currentReturnVar),
      );
    }
    this.symbolTable.exitScope();
    this.currentReturnVar = undefined;
    this.currentRecursiveContext = undefined;
    this.currentMethodName = undefined;
    this.currentParamExportMap = new Map();
    this.currentParamExportReverseMap = new Map();
    this.currentMethodLayout = null;
  }

  const hasOnDeserialization = node.methods.some(
    (method) => method.name === "OnDeserialization",
  );
  if (!hasOnDeserialization) {
    this.emitOnDeserializationForFieldChangeCallbacks(node);
  }
  this.currentClassName = undefined;
}

export function visitEnumDeclaration(
  this: ASTToTACConverter,
  _node: EnumDeclarationNode,
): void {
  // enums are compile-time only
}

export function visitTryCatchStatement(
  this: ASTToTACConverter,
  node: TryCatchStatementNode,
): void {
  const tryId = this.tryCounter++;
  const errorFlagName = `__error_flag_${tryId}`;
  const errorValueName = `__error_value_${tryId}`;

  if (!this.symbolTable.hasInCurrentScope(errorFlagName)) {
    this.symbolTable.addSymbol(
      errorFlagName,
      PrimitiveTypes.boolean,
      false,
      false,
    );
  }
  if (!this.symbolTable.hasInCurrentScope(errorValueName)) {
    this.symbolTable.addSymbol(errorValueName, ObjectType, false, false);
  }

  const errorFlagVar = createVariable(errorFlagName, PrimitiveTypes.boolean);
  const errorValueVar = createVariable(errorValueName, ObjectType);
  const catchLabel = node.catchBody
    ? this.newLabel(`catch_${tryId}`)
    : undefined;
  const finallyLabel = node.finallyBody
    ? this.newLabel(`finally_${tryId}`)
    : undefined;
  const endLabel = this.newLabel(`try_end_${tryId}`);
  const errorTarget = catchLabel ?? finallyLabel ?? endLabel;

  this.instructions.push(
    new AssignmentInstruction(
      errorFlagVar,
      createConstant(false, PrimitiveTypes.boolean),
    ),
  );
  this.instructions.push(
    new AssignmentInstruction(errorValueVar, createConstant(null, ObjectType)),
  );

  const previousInstructions = this.instructions;
  const tryInstructions: TACInstruction[] = [];
  this.instructions = tryInstructions;

  this.tryContextStack.push({
    errorFlag: errorFlagVar,
    errorValue: errorValueVar,
    errorTarget,
    loopDepth: this.loopContextStack.length,
  });
  this.visitBlockStatement(node.tryBody);
  this.tryContextStack.pop();

  this.instructions = previousInstructions;
  this.emitTryInstructionsWithChecks(
    tryInstructions,
    errorFlagVar,
    errorValueVar,
    errorTarget,
  );

  if (catchLabel) {
    this.instructions.push(
      new UnconditionalJumpInstruction(finallyLabel ?? endLabel),
    );
    this.instructions.push(new LabelInstruction(catchLabel));
    if (node.catchBody) {
      this.symbolTable.enterScope();
      if (node.catchVariable) {
        if (!this.symbolTable.hasInCurrentScope(node.catchVariable)) {
          this.symbolTable.addSymbol(
            node.catchVariable,
            ObjectType,
            false,
            false,
          );
        }
        const catchVar = createVariable(node.catchVariable, ObjectType, {
          isLocal: true,
        });
        this.instructions.push(new CopyInstruction(catchVar, errorValueVar));
      }
      this.scanDeclarations(node.catchBody.statements);
      for (const stmt of node.catchBody.statements) {
        this.visitStatement(stmt);
      }
      this.symbolTable.exitScope();
    }
  }

  if (finallyLabel && node.finallyBody) {
    this.instructions.push(new UnconditionalJumpInstruction(finallyLabel));
    this.instructions.push(new LabelInstruction(finallyLabel));
    this.visitBlockStatement(node.finallyBody);
  }

  this.instructions.push(new LabelInstruction(endLabel));
}

export function visitThrowStatement(
  this: ASTToTACConverter,
  node: ThrowStatementNode,
): void {
  const context = this.tryContextStack[this.tryContextStack.length - 1];
  if (!context) {
    const value = this.visitExpression(node.expression);
    const externSig = this.requireExternSignature(
      "Debug",
      "LogError",
      "method",
      ["object"],
      "void",
    );
    this.instructions.push(new CallInstruction(undefined, externSig, [value]));
    const inlineContext =
      this.inlineReturnStack[this.inlineReturnStack.length - 1];
    if (inlineContext) {
      emitLoopExitEpiloguesSinceDepth(this, inlineContext.loopDepth);
      this.instructions.push(
        new UnconditionalJumpInstruction(inlineContext.returnLabel),
      );
    } else {
      emitLoopExitEpilogues(this);
      // If inside a recursive context, reset depth to 0 before aborting.
      // Without this, a subsequent VRC direct call (SendCustomEvent) would
      // see stale depth > 0, skip SP reset, and corrupt the recursion stack.
      if (this.currentRecursiveContext) {
        const depthVar = createVariable(
          this.currentRecursiveContext.depthVar,
          PrimitiveTypes.int32,
        );
        this.instructions.push(
          new CopyInstruction(
            depthVar,
            createConstant(0, PrimitiveTypes.int32),
          ),
        );
      }
      this.instructions.push(
        new ReturnInstruction(undefined, this.currentReturnVar),
      );
    }
    return;
  }
  const value = this.visitExpression(node.expression);
  // Emit loop exit epilogues for any loops entered since the try block started,
  // so viface write-back runs before jumping to the catch handler.
  emitLoopExitEpiloguesSinceDepth(this, context.loopDepth);
  this.instructions.push(
    new AssignmentInstruction(
      context.errorFlag,
      createConstant(true, PrimitiveTypes.boolean),
    ),
  );
  this.instructions.push(new CopyInstruction(context.errorValue, value));
  this.instructions.push(new UnconditionalJumpInstruction(context.errorTarget));
}

export function isDestructureBlock(
  this: ASTToTACConverter,
  node: BlockStatementNode,
): boolean {
  if (node.statements.length === 0) return false;
  if (
    !node.statements.every(
      (stmt) => stmt.kind === ASTNodeKind.VariableDeclaration,
    )
  ) {
    return false;
  }
  const first = node.statements[0] as VariableDeclarationNode;
  return first.name.startsWith("__destructure_");
}
