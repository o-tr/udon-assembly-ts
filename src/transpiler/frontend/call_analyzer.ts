/**
 * Analyze call relationships between classes
 */

import type { ClassRegistry } from "./class_registry.js";
import { isTsOnlyCallExpression } from "./ts_only.js";
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
  type DeleteExpressionNode,
  type ForOfStatementNode,
  type ForStatementNode,
  type IdentifierNode,
  type IfStatementNode,
  type MethodDeclarationNode,
  type ObjectLiteralExpressionNode,
  type PropertyAccessExpressionNode,
  type ReturnStatementNode,
  type UnaryExpressionNode,
  type UpdateExpressionNode,
  type VariableDeclarationNode,
  type WhileStatementNode,
} from "./types.js";

export interface CallAnalysisResult {
  inlineClasses: Set<string>;
  calledUdonBehaviours: Set<string>;
}

export class CallAnalyzer {
  constructor(private registry: ClassRegistry) {}

  analyze(entryPointClassName: string): CallAnalysisResult {
    return this.analyzeClass(entryPointClassName);
  }

  analyzeClass(className: string): CallAnalysisResult {
    const inlineClasses = new Set<string>();
    const calledUdonBehaviours = new Set<string>();

    const mergedMethods = this.registry.getMergedMethods(className);
    for (const method of mergedMethods) {
      this.visitMethod(method.node, inlineClasses, calledUdonBehaviours);
    }

    const mergedProperties = this.registry.getMergedProperties(className);
    for (const prop of mergedProperties) {
      if (prop.node.initializer) {
        this.visitNode(
          prop.node.initializer,
          inlineClasses,
          calledUdonBehaviours,
        );
      }
    }

    const meta = this.registry.getClass(className);
    if (meta?.constructor?.body) {
      this.visitNode(
        meta.constructor.body,
        inlineClasses,
        calledUdonBehaviours,
      );
    }

    return { inlineClasses, calledUdonBehaviours };
  }

  private visitMethod(
    method: MethodDeclarationNode,
    inlineClasses: Set<string>,
    calledUdonBehaviours: Set<string>,
  ): void {
    this.visitBlock(method.body, inlineClasses, calledUdonBehaviours);
  }

  private visitBlock(
    block: BlockStatementNode,
    inlineClasses: Set<string>,
    calledUdonBehaviours: Set<string>,
  ): void {
    for (const stmt of block.statements) {
      this.visitNode(stmt, inlineClasses, calledUdonBehaviours);
    }
  }

  private visitNode(
    node: ASTNode,
    inlineClasses: Set<string>,
    calledUdonBehaviours: Set<string>,
  ): void {
    switch (node.kind) {
      case ASTNodeKind.CallExpression:
        this.visitCallExpression(
          node as CallExpressionNode,
          inlineClasses,
          calledUdonBehaviours,
        );
        break;
      case ASTNodeKind.BlockStatement:
        this.visitBlock(
          node as BlockStatementNode,
          inlineClasses,
          calledUdonBehaviours,
        );
        break;
      case ASTNodeKind.ClassDeclaration: {
        const classNode = node as ClassDeclarationNode;
        for (const method of classNode.methods) {
          this.visitMethod(method, inlineClasses, calledUdonBehaviours);
        }
        break;
      }
      case ASTNodeKind.MethodDeclaration:
        this.visitMethod(
          node as MethodDeclarationNode,
          inlineClasses,
          calledUdonBehaviours,
        );
        break;
      case ASTNodeKind.IfStatement: {
        const ifNode = node as IfStatementNode;
        this.visitNode(ifNode.condition, inlineClasses, calledUdonBehaviours);
        this.visitNode(ifNode.thenBranch, inlineClasses, calledUdonBehaviours);
        if (ifNode.elseBranch) {
          this.visitNode(
            ifNode.elseBranch,
            inlineClasses,
            calledUdonBehaviours,
          );
        }
        break;
      }
      case ASTNodeKind.SwitchStatement: {
        const switchNode = node as unknown as {
          expression: ASTNode;
          cases: ASTNode[];
        };
        this.visitNode(
          switchNode.expression,
          inlineClasses,
          calledUdonBehaviours,
        );
        for (const caseNode of switchNode.cases) {
          this.visitNode(caseNode, inlineClasses, calledUdonBehaviours);
        }
        break;
      }
      case ASTNodeKind.CaseClause: {
        const caseNode = node as unknown as {
          expression: ASTNode | null;
          statements: ASTNode[];
        };
        if (caseNode.expression) {
          this.visitNode(
            caseNode.expression,
            inlineClasses,
            calledUdonBehaviours,
          );
        }
        for (const stmt of caseNode.statements) {
          this.visitNode(stmt, inlineClasses, calledUdonBehaviours);
        }
        break;
      }
      case ASTNodeKind.WhileStatement: {
        const whileNode = node as WhileStatementNode;
        this.visitNode(
          whileNode.condition,
          inlineClasses,
          calledUdonBehaviours,
        );
        this.visitNode(whileNode.body, inlineClasses, calledUdonBehaviours);
        break;
      }
      case ASTNodeKind.DoWhileStatement: {
        const doNode = node as unknown as { body: ASTNode; condition: ASTNode };
        this.visitNode(doNode.body, inlineClasses, calledUdonBehaviours);
        this.visitNode(doNode.condition, inlineClasses, calledUdonBehaviours);
        break;
      }
      case ASTNodeKind.ForStatement: {
        const forNode = node as ForStatementNode;
        if (forNode.initializer) {
          this.visitNode(
            forNode.initializer,
            inlineClasses,
            calledUdonBehaviours,
          );
        }
        if (forNode.condition) {
          this.visitNode(
            forNode.condition,
            inlineClasses,
            calledUdonBehaviours,
          );
        }
        if (forNode.incrementor) {
          this.visitNode(
            forNode.incrementor,
            inlineClasses,
            calledUdonBehaviours,
          );
        }
        this.visitNode(forNode.body, inlineClasses, calledUdonBehaviours);
        break;
      }
      case ASTNodeKind.ForOfStatement: {
        const forOfNode = node as ForOfStatementNode;
        this.visitNode(forOfNode.iterable, inlineClasses, calledUdonBehaviours);
        this.visitNode(forOfNode.body, inlineClasses, calledUdonBehaviours);
        break;
      }
      case ASTNodeKind.AssignmentExpression: {
        const assignNode = node as AssignmentExpressionNode;
        this.visitNode(assignNode.target, inlineClasses, calledUdonBehaviours);
        this.visitNode(assignNode.value, inlineClasses, calledUdonBehaviours);
        break;
      }
      case ASTNodeKind.ConditionalExpression: {
        const condNode = node as unknown as {
          condition: ASTNode;
          whenTrue: ASTNode;
          whenFalse: ASTNode;
        };
        this.visitNode(condNode.condition, inlineClasses, calledUdonBehaviours);
        this.visitNode(condNode.whenTrue, inlineClasses, calledUdonBehaviours);
        this.visitNode(condNode.whenFalse, inlineClasses, calledUdonBehaviours);
        break;
      }
      case ASTNodeKind.NullCoalescingExpression: {
        const coalesceNode = node as unknown as {
          left: ASTNode;
          right: ASTNode;
        };
        this.visitNode(coalesceNode.left, inlineClasses, calledUdonBehaviours);
        this.visitNode(coalesceNode.right, inlineClasses, calledUdonBehaviours);
        break;
      }
      case ASTNodeKind.TemplateExpression: {
        const templateNode = node as unknown as {
          parts: Array<{ kind: string; expression?: ASTNode }>;
        };
        for (const part of templateNode.parts) {
          if (part.kind === "expression" && part.expression) {
            this.visitNode(
              part.expression,
              inlineClasses,
              calledUdonBehaviours,
            );
          }
        }
        break;
      }
      case ASTNodeKind.BinaryExpression: {
        const binNode = node as BinaryExpressionNode;
        this.visitNode(binNode.left, inlineClasses, calledUdonBehaviours);
        this.visitNode(binNode.right, inlineClasses, calledUdonBehaviours);
        break;
      }
      case ASTNodeKind.UnaryExpression: {
        const unNode = node as UnaryExpressionNode;
        this.visitNode(unNode.operand, inlineClasses, calledUdonBehaviours);
        break;
      }
      case ASTNodeKind.UpdateExpression: {
        const updateNode = node as UpdateExpressionNode;
        this.visitNode(updateNode.operand, inlineClasses, calledUdonBehaviours);
        break;
      }
      case ASTNodeKind.AsExpression: {
        const asNode = node as AsExpressionNode;
        this.visitNode(asNode.expression, inlineClasses, calledUdonBehaviours);
        break;
      }
      case ASTNodeKind.DeleteExpression: {
        const delNode = node as DeleteExpressionNode;
        this.visitNode(delNode.target, inlineClasses, calledUdonBehaviours);
        break;
      }
      case ASTNodeKind.ArrayLiteralExpression: {
        const arrayNode = node as ArrayLiteralExpressionNode;
        for (const elem of arrayNode.elements) {
          this.visitNode(elem.value, inlineClasses, calledUdonBehaviours);
        }
        break;
      }
      case ASTNodeKind.ArrayAccessExpression: {
        const arrayAccess = node as ArrayAccessExpressionNode;
        this.visitNode(arrayAccess.array, inlineClasses, calledUdonBehaviours);
        this.visitNode(arrayAccess.index, inlineClasses, calledUdonBehaviours);
        break;
      }
      case ASTNodeKind.ObjectLiteralExpression: {
        const objNode = node as ObjectLiteralExpressionNode;
        for (const prop of objNode.properties) {
          this.visitNode(prop.value, inlineClasses, calledUdonBehaviours);
        }
        break;
      }
      case ASTNodeKind.PropertyAccessExpression: {
        const propNode = node as PropertyAccessExpressionNode;
        if (propNode.object.kind === ASTNodeKind.Identifier) {
          const identName = (propNode.object as IdentifierNode).name;
          const target = this.registry.getClass(identName);
          if (target && !this.registry.isStub(identName)) {
            if (target.isEntryPoint) {
              calledUdonBehaviours.add(identName);
            } else {
              inlineClasses.add(identName);
            }
          }
        }
        this.visitNode(propNode.object, inlineClasses, calledUdonBehaviours);
        break;
      }
      case ASTNodeKind.OptionalChainingExpression: {
        const optNode = node as unknown as { object: ASTNode };
        this.visitNode(optNode.object, inlineClasses, calledUdonBehaviours);
        break;
      }
      case ASTNodeKind.VariableDeclaration: {
        const varNode = node as VariableDeclarationNode;
        if (varNode.initializer) {
          this.visitNode(
            varNode.initializer,
            inlineClasses,
            calledUdonBehaviours,
          );
        }
        break;
      }
      case ASTNodeKind.TryCatchStatement: {
        const tryNode = node as unknown as {
          tryBody: BlockStatementNode;
          catchBody?: BlockStatementNode;
          finallyBody?: BlockStatementNode;
        };
        this.visitNode(tryNode.tryBody, inlineClasses, calledUdonBehaviours);
        if (tryNode.catchBody) {
          this.visitNode(
            tryNode.catchBody,
            inlineClasses,
            calledUdonBehaviours,
          );
        }
        if (tryNode.finallyBody) {
          this.visitNode(
            tryNode.finallyBody,
            inlineClasses,
            calledUdonBehaviours,
          );
        }
        break;
      }
      case ASTNodeKind.ThrowStatement: {
        const throwNode = node as unknown as { expression: ASTNode };
        this.visitNode(
          throwNode.expression,
          inlineClasses,
          calledUdonBehaviours,
        );
        break;
      }
      case ASTNodeKind.ReturnStatement: {
        const retNode = node as ReturnStatementNode;
        if (retNode.value) {
          this.visitNode(retNode.value, inlineClasses, calledUdonBehaviours);
        }
        break;
      }
      default:
        break;
    }
  }

  private visitCallExpression(
    node: CallExpressionNode,
    inlineClasses: Set<string>,
    calledUdonBehaviours: Set<string>,
  ): void {
    if (isTsOnlyCallExpression(node)) {
      return;
    }
    const className = this.extractClassName(node.callee);

    if (className) {
      const target = this.registry.getClass(className);
      if (target && !this.registry.isStub(className)) {
        if (target.isEntryPoint) {
          calledUdonBehaviours.add(className);
        } else {
          inlineClasses.add(className);
        }
      }
    }

    this.visitNode(node.callee, inlineClasses, calledUdonBehaviours);
    for (const arg of node.arguments) {
      this.visitNode(arg, inlineClasses, calledUdonBehaviours);
    }
  }

  private extractClassName(node: ASTNode): string | undefined {
    switch (node.kind) {
      case ASTNodeKind.PropertyAccessExpression: {
        const propNode = node as PropertyAccessExpressionNode;
        return this.extractClassName(propNode.object);
      }
      case ASTNodeKind.CallExpression: {
        const callNode = node as CallExpressionNode;
        return this.extractClassName(callNode.callee);
      }
      case ASTNodeKind.Identifier: {
        const ident = node as IdentifierNode;
        return ident.name;
      }
      case ASTNodeKind.ArrayAccessExpression: {
        const arrayAccess = node as ArrayAccessExpressionNode;
        return this.extractClassName(arrayAccess.array);
      }
      default:
        return undefined;
    }
  }
}
