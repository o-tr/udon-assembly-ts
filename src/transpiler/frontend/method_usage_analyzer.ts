/**
 * Method usage analyzer for tree-shaking unused methods.
 */

import type { ClassRegistry, MethodInfo } from "./class_registry.js";
import { isTsOnlyCallExpression } from "./ts_only.js";
import {
  type ASTNode,
  ASTNodeKind,
  type CallExpressionNode,
  type IdentifierNode,
  type LiteralNode,
  type OptionalChainingExpressionNode,
  type PropertyAccessExpressionNode,
} from "./types.js";

const SEND_EVENT_ARG_INDEX: Record<string, number> = {
  SendCustomEvent: 0,
  SendCustomEventDelayedSeconds: 0,
  SendCustomEventDelayedFrames: 0,
  SendCustomNetworkEvent: 1,
  sendCustomNetworkEvent: 1,
};

const SEND_EVENT_METHODS = new Set(Object.keys(SEND_EVENT_ARG_INDEX));

type MethodKey = { className: string; methodName: string };

type CallTarget =
  | {
      kind: "method";
      methodName: string;
      className?: string;
      udonOnly?: boolean;
    }
  | { kind: "constructor"; className: string };

export class MethodUsageAnalyzer {
  private methodsByClass = new Map<string, Map<string, MethodInfo>>();
  private ownersByName = new Map<string, Set<string>>();
  private udonBehaviourClasses = new Set<string>();

  constructor(private readonly registry: ClassRegistry) {}

  analyze(): Map<string, Set<string>> {
    this.buildIndex();

    const reachable = new Map<string, Set<string>>();
    const visitedMethods = new Set<string>();
    const visitedConstructors = new Set<string>();
    const queue: MethodKey[] = [];

    for (const className of this.udonBehaviourClasses) {
      const methodMap = this.methodsByClass.get(className);
      if (!methodMap) continue;
      for (const method of methodMap.values()) {
        queue.push({ className, methodName: method.name });
      }
    }

    const enqueueMethod = (className: string, methodName: string) => {
      const key = `${className}.${methodName}`;
      if (visitedMethods.has(key)) return;
      queue.push({ className, methodName });
    };

    const enqueueByName = (methodName: string, udonOnly = false) => {
      const owners = this.ownersByName.get(methodName);
      if (!owners) return;
      for (const className of owners) {
        if (udonOnly && !this.udonBehaviourClasses.has(className)) {
          continue;
        }
        enqueueMethod(className, methodName);
      }
    };

    const processTargets = (targets: CallTarget[]) => {
      for (const target of targets) {
        if (target.kind === "constructor") {
          if (visitedConstructors.has(target.className)) continue;
          visitedConstructors.add(target.className);
          const ctorTargets: CallTarget[] = [];
          this.collectConstructorTargets(target.className, ctorTargets);
          processTargets(ctorTargets);
          continue;
        }
        if (target.className) {
          enqueueMethod(target.className, target.methodName);
        } else {
          enqueueByName(target.methodName, target.udonOnly ?? false);
        }
      }
    };

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      const key = `${current.className}.${current.methodName}`;
      if (visitedMethods.has(key)) continue;
      visitedMethods.add(key);

      if (!reachable.has(current.className)) {
        reachable.set(current.className, new Set());
      }
      reachable.get(current.className)?.add(current.methodName);

      const methodInfo = this.methodsByClass
        .get(current.className)
        ?.get(current.methodName);
      if (!methodInfo) continue;

      const targets: CallTarget[] = [];
      this.collectCallTargetsFromNode(
        methodInfo.node.body,
        current.className,
        targets,
      );
      processTargets(targets);
    }

    return reachable;
  }

  private buildIndex(): void {
    this.methodsByClass.clear();
    this.ownersByName.clear();
    this.udonBehaviourClasses.clear();

    for (const cls of this.registry.getAllClasses()) {
      if (this.registry.isStub(cls.name)) continue;
      if (cls.isEntryPoint) {
        this.udonBehaviourClasses.add(cls.name);
      }
      const mergedMethods = this.registry.getMergedMethods(cls.name);
      const methodMap = new Map<string, MethodInfo>();
      for (const method of mergedMethods) {
        methodMap.set(method.name, method);
        if (!this.ownersByName.has(method.name)) {
          this.ownersByName.set(method.name, new Set());
        }
        this.ownersByName.get(method.name)?.add(cls.name);
      }
      this.methodsByClass.set(cls.name, methodMap);
    }
  }

  private collectConstructorTargets(
    className: string,
    out: CallTarget[],
  ): void {
    const mergedProperties = this.registry.getMergedProperties(className);
    for (const prop of mergedProperties) {
      if (prop.node.initializer) {
        this.collectCallTargetsFromNode(prop.node.initializer, className, out);
      }
    }

    const meta = this.registry.getClass(className);
    if (meta?.constructor?.body) {
      this.collectCallTargetsFromNode(meta.constructor.body, className, out);
    }
  }

  private collectCallTargetsFromNode(
    node: ASTNode,
    currentClass: string,
    out: CallTarget[],
  ): void {
    if (!this.isAstNode(node)) return;

    if (node.kind === ASTNodeKind.CallExpression) {
      const callNode = node as CallExpressionNode;
      if (isTsOnlyCallExpression(callNode)) {
        return;
      }
      this.handleCallExpression(callNode, currentClass, out);
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (this.isAstNode(item)) {
            this.collectCallTargetsFromNode(item, currentClass, out);
          }
        }
        continue;
      }
      if (this.isAstNode(value)) {
        this.collectCallTargetsFromNode(value, currentClass, out);
      }
    }
  }

  private handleCallExpression(
    call: CallExpressionNode,
    currentClass: string,
    out: CallTarget[],
  ): void {
    if (call.isNew) {
      const ctorClass = this.extractIdentifierName(call.callee);
      if (ctorClass && this.methodsByClass.has(ctorClass)) {
        out.push({ kind: "constructor", className: ctorClass });
      }
      return;
    }

    const sendTargets = this.extractSendCustomEventTargets(call, currentClass);
    if (sendTargets.length > 0) {
      out.push(...sendTargets);
      return;
    }

    const target = this.resolveCallTarget(call.callee, currentClass);
    if (target) out.push(target);
  }

  private extractSendCustomEventTargets(
    call: CallExpressionNode,
    currentClass: string,
  ): CallTarget[] {
    const calleeInfo = this.getSendCustomEventCallee(call.callee, currentClass);
    if (!calleeInfo) return [];

    const argIndex = SEND_EVENT_ARG_INDEX[calleeInfo.methodName];
    const arg = call.arguments[argIndex];
    const eventName = this.getStringLiteralValue(arg);
    if (!eventName) return [];

    return [
      {
        kind: "method",
        methodName: eventName,
        className: calleeInfo.className,
        udonOnly: calleeInfo.udonOnly,
      },
    ];
  }

  private getSendCustomEventCallee(
    callee: ASTNode,
    currentClass: string,
  ): { methodName: string; className?: string; udonOnly?: boolean } | null {
    if (callee.kind === ASTNodeKind.Identifier) {
      const name = (callee as IdentifierNode).name;
      if (!SEND_EVENT_METHODS.has(name)) return null;
      return { methodName: name, className: currentClass };
    }

    if (callee.kind === ASTNodeKind.PropertyAccessExpression) {
      const prop = callee as PropertyAccessExpressionNode;
      if (!SEND_EVENT_METHODS.has(prop.property)) return null;
      const receiver = prop.object;
      if (receiver.kind === ASTNodeKind.ThisExpression) {
        return { methodName: prop.property, className: currentClass };
      }
      return { methodName: prop.property, udonOnly: true };
    }

    if (callee.kind === ASTNodeKind.OptionalChainingExpression) {
      const opt = callee as OptionalChainingExpressionNode;
      if (!SEND_EVENT_METHODS.has(opt.property)) return null;
      const receiver = opt.object;
      if (receiver.kind === ASTNodeKind.ThisExpression) {
        return { methodName: opt.property, className: currentClass };
      }
      return { methodName: opt.property, udonOnly: true };
    }

    return null;
  }

  private resolveCallTarget(
    callee: ASTNode,
    currentClass: string,
  ): CallTarget | null {
    switch (callee.kind) {
      case ASTNodeKind.PropertyAccessExpression: {
        const prop = callee as PropertyAccessExpressionNode;
        const obj = prop.object;
        if (obj.kind === ASTNodeKind.ThisExpression) {
          return {
            kind: "method",
            className: currentClass,
            methodName: prop.property,
          };
        }
        if (obj.kind === ASTNodeKind.SuperExpression) {
          const baseClass = this.registry.getClass(currentClass)?.baseClass;
          if (baseClass) {
            return {
              kind: "method",
              className: baseClass,
              methodName: prop.property,
            };
          }
          return { kind: "method", methodName: prop.property };
        }
        if (obj.kind === ASTNodeKind.Identifier) {
          const name = (obj as IdentifierNode).name;
          if (this.methodsByClass.has(name)) {
            return {
              kind: "method",
              className: name,
              methodName: prop.property,
            };
          }
        }
        return { kind: "method", methodName: prop.property };
      }
      case ASTNodeKind.OptionalChainingExpression: {
        const opt = callee as OptionalChainingExpressionNode;
        const obj = opt.object;
        if (obj.kind === ASTNodeKind.ThisExpression) {
          return {
            kind: "method",
            className: currentClass,
            methodName: opt.property,
          };
        }
        if (obj.kind === ASTNodeKind.Identifier) {
          const name = (obj as IdentifierNode).name;
          if (this.methodsByClass.has(name)) {
            return {
              kind: "method",
              className: name,
              methodName: opt.property,
            };
          }
        }
        return { kind: "method", methodName: opt.property };
      }
      case ASTNodeKind.Identifier: {
        const ident = callee as IdentifierNode;
        if (this.methodsByClass.get(currentClass)?.has(ident.name)) {
          return {
            kind: "method",
            className: currentClass,
            methodName: ident.name,
          };
        }
        return null;
      }
      default:
        return null;
    }
  }

  private extractIdentifierName(node: ASTNode): string | null {
    if (node.kind === ASTNodeKind.Identifier) {
      return (node as IdentifierNode).name;
    }
    return null;
  }

  private getStringLiteralValue(node?: ASTNode): string | null {
    if (!node) return null;
    if (node.kind !== ASTNodeKind.Literal) return null;
    const literal = node as LiteralNode;
    return typeof literal.value === "string" ? literal.value : null;
  }

  private isAstNode(value: unknown): value is ASTNode {
    return typeof value === "object" && value !== null && "kind" in value;
  }
}
