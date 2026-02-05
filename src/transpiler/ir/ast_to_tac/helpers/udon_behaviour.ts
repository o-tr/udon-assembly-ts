import type { TypeSymbol } from "../../../frontend/type_symbols.js";
import { ObjectType, PrimitiveTypes } from "../../../frontend/type_symbols.js";
import {
  type ASTNode,
  ASTNodeKind,
  type ClassDeclarationNode,
  type IdentifierNode,
  type PropertyAccessExpressionNode,
} from "../../../frontend/types.js";
import type { UdonBehaviourClassLayout } from "../../udon_behaviour_layout.js";
import {
  BinaryOpInstruction,
  ConditionalJumpInstruction,
  CopyInstruction,
  LabelInstruction,
  MethodCallInstruction,
  PropertyGetInstruction,
  ReturnInstruction,
} from "../../tac_instruction.js";
import {
  createLabel,
  createVariable,
  type TACOperand,
} from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";

export function isUdonBehaviourType(
  this: ASTToTACConverter,
  type: TypeSymbol | undefined,
): boolean {
  if (!type) return false;
  const classNode = this.classMap.get(type.name);
  if (classNode) {
    return classNode.decorators.some(
      (decorator) => decorator.name === "UdonBehaviour",
    );
  }
  return this.udonBehaviourClasses.has(type.name);
}

export function getUdonBehaviourLayout(
  this: ASTToTACConverter,
  className: string,
): UdonBehaviourClassLayout | null {
  return this.udonBehaviourLayouts.get(className) ?? null;
}

export function isUdonBehaviourPropertyAccess(
  this: ASTToTACConverter,
  propAccess: PropertyAccessExpressionNode,
): boolean {
  if (propAccess.object.kind === ASTNodeKind.Identifier) {
    const name = (propAccess.object as IdentifierNode).name;
    const symbol = this.symbolTable.lookup(name);
    return !!symbol && this.isUdonBehaviourType(symbol.type);
  }

  if (propAccess.object.kind === ASTNodeKind.PropertyAccessExpression) {
    const inner = propAccess.object as PropertyAccessExpressionNode;
    if (inner.object.kind === ASTNodeKind.ThisExpression) {
      const symbol = this.symbolTable.lookup(inner.property);
      if (symbol && this.isUdonBehaviourType(symbol.type)) {
        return true;
      }
      if (this.currentClassName) {
        const classNode = this.classMap.get(this.currentClassName);
        const prop = classNode?.properties.find(
          (p) => p.name === inner.property,
        );
        if (prop && this.isUdonBehaviourType(prop.type)) {
          return true;
        }
      }
      return false;
    }
  }

  return false;
}

export function resolveFieldChangeCallback(
  this: ASTToTACConverter,
  object: ASTNode,
  property: string,
): string | null {
  let className: string | undefined;
  if (object.kind === ASTNodeKind.ThisExpression) {
    className = this.currentClassName;
  } else if (object.kind === ASTNodeKind.Identifier) {
    const instanceInfo = this.inlineInstanceMap.get(
      (object as IdentifierNode).name,
    );
    if (instanceInfo) {
      className = instanceInfo.className;
    }
  }

  if (!className) return null;
  const classNode = this.classMap.get(className);
  const prop = classNode?.properties.find((p) => p.name === property);
  return prop?.fieldChangeCallback ?? null;
}

export function emitOnDeserializationForFieldChangeCallbacks(
  this: ASTToTACConverter,
  classNode: ClassDeclarationNode,
): void {
  const callbacks = classNode.properties.filter(
    (prop) => !!prop.fieldChangeCallback,
  );
  if (callbacks.length === 0) return;

  const label = createLabel("_onDeserialization");
  this.instructions.push(new LabelInstruction(label));
  this.currentReturnVar = "__returnValue_return";
  this.symbolTable.enterScope();

  const thisVar = createVariable("this", ObjectType);

  for (const prop of callbacks) {
    const prevVar = createVariable(`__prev_${prop.name}`, prop.type);
    if (!this.symbolTable.hasInCurrentScope(prevVar.name)) {
      this.symbolTable.addSymbol(prevVar.name, prop.type, false, false);
    }

    const currentVal = this.newTemp(prop.type);
    this.instructions.push(
      new PropertyGetInstruction(currentVal, thisVar, prop.name),
    );

    const changed = this.newTemp(PrimitiveTypes.boolean);
    this.instructions.push(
      new BinaryOpInstruction(changed, currentVal, "!=", prevVar),
    );
    const skipLabel = this.newLabel("fcb_skip");
    this.instructions.push(
      new ConditionalJumpInstruction(changed, skipLabel),
    );
    this.instructions.push(new CopyInstruction(prevVar, currentVal));
    if (prop.fieldChangeCallback) {
      this.instructions.push(
        new MethodCallInstruction(
          undefined,
          thisVar,
          prop.fieldChangeCallback,
          [],
        ),
      );
    }
    this.instructions.push(new LabelInstruction(skipLabel));
  }

  this.instructions.push(
    new ReturnInstruction(undefined, this.currentReturnVar),
  );
  this.symbolTable.exitScope();
  this.currentReturnVar = undefined;
}
