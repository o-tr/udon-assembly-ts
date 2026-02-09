/**
 * Class registry for transpiler
 */

import {
  type ASTNode,
  ASTNodeKind,
  type ClassDeclarationNode,
  type DecoratorNode,
  type InterfaceDeclarationNode,
  type MethodDeclarationNode,
  type ProgramNode,
  type PropertyDeclarationNode,
  type VariableDeclarationNode,
} from "./types.js";

export interface DecoratorInfo {
  name: string;
  arguments: unknown[];
}

export interface MethodInfo {
  name: string;
  parameters: Array<{ name: string; type: string }>;
  returnType: string;
  isPublic: boolean;
  isStatic: boolean;
  isExported?: boolean;
  node: MethodDeclarationNode;
}

export interface PropertyInfo {
  name: string;
  type: string;
  isPublic: boolean;
  isStatic: boolean;
  node: PropertyDeclarationNode;
  syncMode?: string;
  fieldChangeCallback?: string;
  isSerializeField?: boolean;
}

export interface ClassMetadata {
  name: string;
  filePath: string;
  baseClass: string | null;
  decorators: DecoratorInfo[];
  isEntryPoint: boolean;
  methods: MethodInfo[];
  properties: PropertyInfo[];
  constructor?: {
    parameters: Array<{ name: string; type: string }>;
    body: ASTNode;
  };
  node: ClassDeclarationNode;
  behaviourSyncMode?: string;
}

export interface TopLevelConstInfo {
  name: string;
  type: string;
  node: VariableDeclarationNode;
  filePath: string;
  line: number;
  column: number;
}

export interface InterfaceMetadata {
  name: string;
  filePath: string;
  properties: Array<{ name: string; type: string }>;
  methods: Array<{
    name: string;
    parameters: Array<{ name: string; type: string }>;
    returnType: string;
  }>;
  node: InterfaceDeclarationNode;
}

export class ClassRegistry {
  private classes: Map<string, ClassMetadata> = new Map();
  private interfaces: Map<string, InterfaceMetadata> = new Map();
  private topLevelConsts: Map<string, TopLevelConstInfo[]> = new Map();

  register(classInfo: ClassMetadata): void {
    this.classes.set(classInfo.name, classInfo);
  }

  getClass(name: string): ClassMetadata | undefined {
    return this.classes.get(name);
  }

  getInterface(name: string): InterfaceMetadata | undefined {
    return this.interfaces.get(name);
  }

  getInheritanceChain(className: string): string[] {
    const chain: string[] = [];
    let current = this.classes.get(className);
    while (current) {
      chain.push(current.name);
      if (!current.baseClass) break;
      current = this.classes.get(current.baseClass);
    }
    return chain;
  }

  getEntryPoints(): ClassMetadata[] {
    return Array.from(this.classes.values()).filter((cls) => cls.isEntryPoint);
  }

  getAllClasses(): ClassMetadata[] {
    return Array.from(this.classes.values());
  }

  getClassesInFile(filePath: string): ClassMetadata[] {
    return Array.from(this.classes.values()).filter(
      (cls) => cls.filePath === filePath,
    );
  }

  isStub(className: string): boolean {
    const metadata = this.classes.get(className);
    if (!metadata) return false;
    return metadata.decorators.some(
      (decorator) => decorator.name === "UdonStub",
    );
  }

  getMergedMethods(className: string): MethodInfo[] {
    const chain = this.getInheritanceChain(className).slice().reverse();
    const merged = new Map<string, MethodInfo>();

    for (const name of chain) {
      if (this.isStub(name)) continue;
      const metadata = this.classes.get(name);
      if (!metadata) continue;
      for (const method of metadata.methods) {
        merged.set(method.name, method);
      }
    }

    return Array.from(merged.values());
  }

  getMergedProperties(className: string): PropertyInfo[] {
    const chain = this.getInheritanceChain(className).slice().reverse();
    const merged = new Map<string, PropertyInfo>();

    for (const name of chain) {
      if (this.isStub(name)) continue;
      const metadata = this.classes.get(name);
      if (!metadata) continue;
      for (const prop of metadata.properties) {
        merged.set(prop.name, prop);
      }
    }

    return Array.from(merged.values());
  }

  getTopLevelConstsForFile(filePath: string): TopLevelConstInfo[] {
    return this.topLevelConsts.get(filePath) ?? [];
  }

  registerFromProgram(
    program: ProgramNode,
    filePath: string,
    sourceText?: string,
  ): void {
    const consts: TopLevelConstInfo[] = [];
    const lineStarts = sourceText ? this.computeLineStarts(sourceText) : null;
    for (const stmt of program.statements) {
      if (
        stmt.kind === ASTNodeKind.VariableDeclaration &&
        (stmt as VariableDeclarationNode).isConst
      ) {
        const varNode = stmt as VariableDeclarationNode;
        const loc = this.findConstLocation(
          varNode.name,
          sourceText,
          lineStarts,
        );
        consts.push({
          name: varNode.name,
          type: varNode.type.name,
          node: varNode,
          filePath,
          line: loc.line,
          column: loc.column,
        });
      }
    }
    if (consts.length > 0) {
      this.topLevelConsts.set(filePath, consts);
    }

    for (const stmt of program.statements) {
      if (stmt.kind === ASTNodeKind.InterfaceDeclaration) {
        const interfaceNode = stmt as InterfaceDeclarationNode;
        this.interfaces.set(interfaceNode.name, {
          name: interfaceNode.name,
          filePath,
          properties: interfaceNode.properties.map((prop) => ({
            name: prop.name,
            type: prop.type.name,
          })),
          methods: interfaceNode.methods.map((method) => ({
            name: method.name,
            parameters: method.parameters.map((param) => ({
              name: param.name,
              type: param.type.name,
            })),
            returnType: method.returnType.name,
          })),
          node: interfaceNode,
        });
        continue;
      }
      if (stmt.kind !== ASTNodeKind.ClassDeclaration) continue;
      const classNode = stmt as ClassDeclarationNode;
      const decorators = classNode.decorators.map((decorator) =>
        this.toDecoratorInfo(decorator),
      );
      const isEntryPoint = decorators.some(
        (decorator) => decorator.name === "UdonBehaviour",
      );
      const methods = classNode.methods.map((method) =>
        this.toMethodInfo(method),
      );
      const properties = classNode.properties.map((prop) =>
        this.toPropertyInfo(prop),
      );
      const behaviourSyncMode = decorators.find(
        (decorator) => decorator.name === "UdonBehaviour",
      )?.arguments?.[0];

      this.register({
        name: classNode.name,
        filePath,
        baseClass: classNode.baseClass,
        decorators,
        isEntryPoint,
        methods,
        properties,
        constructor: classNode.constructor,
        node: classNode,
        behaviourSyncMode:
          typeof behaviourSyncMode === "string"
            ? behaviourSyncMode
            : typeof behaviourSyncMode === "object" &&
                behaviourSyncMode !== null &&
                "syncMode" in behaviourSyncMode
              ? String(
                  (behaviourSyncMode as { syncMode?: string }).syncMode ?? "",
                )
              : undefined,
      });
    }
  }

  getAllInterfaces(): InterfaceMetadata[] {
    return Array.from(this.interfaces.values());
  }

  getUdonBehaviourInterfaces(): Map<string, InterfaceMetadata> {
    const result = new Map<string, InterfaceMetadata>();
    for (const cls of this.classes.values()) {
      const isUdonBehaviour = cls.decorators.some(
        (d) => d.name === "UdonBehaviour",
      );
      if (!isUdonBehaviour) continue;
      for (const ifaceName of cls.node.implements ?? []) {
        const iface = this.interfaces.get(ifaceName);
        if (iface && !result.has(ifaceName)) {
          result.set(ifaceName, iface);
        }
      }
    }
    return result;
  }

  getImplementorsOfInterface(interfaceName: string): ClassMetadata[] {
    return Array.from(this.classes.values()).filter((cls) =>
      (cls.node.implements ?? []).includes(interfaceName),
    );
  }

  getClassImplementsMap(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const cls of this.classes.values()) {
      const impls = cls.node.implements ?? [];
      if (impls.length > 0) {
        result.set(cls.name, [...impls]);
      }
    }
    return result;
  }

  private toDecoratorInfo(decorator: DecoratorNode): DecoratorInfo {
    return {
      name: decorator.name,
      arguments: decorator.arguments,
    };
  }

  private toMethodInfo(method: MethodDeclarationNode): MethodInfo {
    return {
      name: method.name,
      parameters: method.parameters.map((param) => ({
        name: param.name,
        type: param.type.name,
      })),
      returnType: method.returnType.name,
      isPublic: method.isPublic,
      isStatic: method.isStatic,
      isExported: method.isExported,
      node: method,
    };
  }

  private toPropertyInfo(property: PropertyDeclarationNode): PropertyInfo {
    return {
      name: property.name,
      type: property.type.name,
      isPublic: property.isPublic,
      isStatic: property.isStatic,
      node: property,
      syncMode: property.syncMode,
      fieldChangeCallback: property.fieldChangeCallback,
      isSerializeField: property.isSerializeField,
    };
  }

  private computeLineStarts(sourceText: string): number[] {
    const starts = [0];
    for (let i = 0; i < sourceText.length; i++) {
      if (sourceText[i] === "\n") {
        starts.push(i + 1);
      }
    }
    return starts;
  }

  private findConstLocation(
    name: string,
    sourceText: string | undefined,
    lineStarts: number[] | null,
  ): { line: number; column: number } {
    if (!sourceText || !lineStarts) return { line: 1, column: 1 };
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\bconst\\s+${escaped}\\b`);
    const match = pattern.exec(sourceText);
    if (!match) return { line: 1, column: 1 };
    const offset = match.index;
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
  }
}
