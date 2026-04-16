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
    parameters: Array<{
      name: string;
      type: string;
      isParameterProperty?: boolean;
    }>;
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

  private inheritanceChainCache = new Map<string, readonly string[]>();
  private reversedInheritanceChainCache = new Map<string, readonly string[]>();
  private mergedMethodsCache = new Map<string, readonly MethodInfo[]>();
  private mergedPropertiesCache = new Map<string, readonly PropertyInfo[]>();
  private mergedMethodByNameCache = new Map<string, Map<string, MethodInfo>>();
  private mergedPropertyByNameCache = new Map<
    string,
    Map<string, PropertyInfo>
  >();
  private stubCache = new Map<string, boolean>();
  private implementedInterfacesCache = new Map<string, readonly string[]>();
  private entryPointsCache: readonly ClassMetadata[] | null = null;
  private cachesDirty = false;

  register(classInfo: ClassMetadata): void {
    this.classes.set(classInfo.name, classInfo);
    this.cachesDirty = true;
  }

  private clearCaches(): void {
    this.inheritanceChainCache.clear();
    this.reversedInheritanceChainCache.clear();
    this.mergedMethodsCache.clear();
    this.mergedPropertiesCache.clear();
    this.mergedMethodByNameCache.clear();
    this.mergedPropertyByNameCache.clear();
    this.stubCache.clear();
    this.implementedInterfacesCache.clear();
    this.entryPointsCache = null;
  }

  private ensureCachesClean(): void {
    if (this.cachesDirty) {
      this.clearCaches();
      this.cachesDirty = false;
    }
  }

  getClass(name: string): ClassMetadata | undefined {
    return this.classes.get(name);
  }

  getInterface(name: string): InterfaceMetadata | undefined {
    return this.interfaces.get(name);
  }

  getInheritanceChain(className: string): readonly string[] {
    this.ensureCachesClean();
    const cached = this.inheritanceChainCache.get(className);
    if (cached) return cached;

    const chain: string[] = [];
    let current = this.classes.get(className);
    while (current) {
      chain.push(current.name);
      if (!current.baseClass) break;
      current = this.classes.get(current.baseClass);
    }
    this.inheritanceChainCache.set(className, chain);
    return chain;
  }

  private getReversedInheritanceChain(className: string): readonly string[] {
    const cached = this.reversedInheritanceChainCache.get(className);
    if (cached) return cached;
    const reversed = [...this.getInheritanceChain(className)].reverse();
    this.reversedInheritanceChainCache.set(className, reversed);
    return reversed;
  }

  getEntryPoints(): readonly ClassMetadata[] {
    this.ensureCachesClean();
    if (this.entryPointsCache) return this.entryPointsCache;
    this.entryPointsCache = Array.from(this.classes.values()).filter(
      (cls) => cls.isEntryPoint,
    );
    return this.entryPointsCache;
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
    this.ensureCachesClean();
    const cached = this.stubCache.get(className);
    if (cached !== undefined) return cached;

    const metadata = this.classes.get(className);
    if (!metadata) {
      this.stubCache.set(className, false);
      return false;
    }
    const result = metadata.decorators.some(
      (decorator) => decorator.name === "UdonStub",
    );
    this.stubCache.set(className, result);
    return result;
  }

  private ensureMergedMethodsMaps(className: string): Map<string, MethodInfo> {
    const cached = this.mergedMethodByNameCache.get(className);
    if (cached) return cached;

    const chain = this.getReversedInheritanceChain(className);
    const merged = new Map<string, MethodInfo>();

    for (const name of chain) {
      if (this.isStub(name)) continue;
      const metadata = this.classes.get(name);
      if (!metadata) continue;
      for (const method of metadata.methods) {
        merged.set(method.name, method);
      }
    }

    this.mergedMethodByNameCache.set(className, merged);
    const arr = Array.from(merged.values());
    this.mergedMethodsCache.set(className, arr);
    return merged;
  }

  getMergedMethods(className: string): readonly MethodInfo[] {
    this.ensureCachesClean();
    const cached = this.mergedMethodsCache.get(className);
    if (cached) return cached;
    this.ensureMergedMethodsMaps(className);
    return this.mergedMethodsCache.get(className) ?? [];
  }

  getMergedMethod(
    className: string,
    methodName: string,
  ): MethodInfo | undefined {
    this.ensureCachesClean();
    return this.ensureMergedMethodsMaps(className).get(methodName);
  }

  private ensureMergedPropertiesMaps(
    className: string,
  ): Map<string, PropertyInfo> {
    const cached = this.mergedPropertyByNameCache.get(className);
    if (cached) return cached;

    const chain = this.getReversedInheritanceChain(className);
    const merged = new Map<string, PropertyInfo>();

    for (const name of chain) {
      if (this.isStub(name)) continue;
      const metadata = this.classes.get(name);
      if (!metadata) continue;
      for (const prop of metadata.properties) {
        merged.set(prop.name, prop);
      }
    }

    this.mergedPropertyByNameCache.set(className, merged);
    const arr = Array.from(merged.values());
    this.mergedPropertiesCache.set(className, arr);
    return merged;
  }

  getMergedProperties(className: string): readonly PropertyInfo[] {
    this.ensureCachesClean();
    const cached = this.mergedPropertiesCache.get(className);
    if (cached) return cached;
    this.ensureMergedPropertiesMaps(className);
    return this.mergedPropertiesCache.get(className) ?? [];
  }

  getMergedProperty(
    className: string,
    propName: string,
  ): PropertyInfo | undefined {
    this.ensureCachesClean();
    return this.ensureMergedPropertiesMaps(className).get(propName);
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

    let registeredAnyClass = false;
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

      this.classes.set(classNode.name, {
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
      registeredAnyClass = true;
    }
    if (registeredAnyClass) {
      this.cachesDirty = true;
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
      for (const ifaceName of this.getAllImplementedInterfaces(cls.name)) {
        const iface = this.interfaces.get(ifaceName);
        if (iface && !result.has(ifaceName)) {
          result.set(ifaceName, iface);
        }
      }
    }
    return result;
  }

  getImplementorsOfInterface(interfaceName: string): ClassMetadata[] {
    this.ensureCachesClean();
    return Array.from(this.classes.values()).filter((cls) =>
      this.classImplementsInterface(cls.name, interfaceName),
    );
  }

  /**
   * Return all interfaces a class implements, including those inherited
   * through the base class chain. Results are deduplicated.
   * Cache is invalidated lazily via the `cachesDirty` flag, so results are
   * only reliable after all classes have been registered (post-parsing phase).
   *
   * Limitation: interface-extends-interface relationships are not traversed
   * because InterfaceDeclarationNode does not currently have an `extends`
   * field. A class implementing IYaku (which extends IScorer) will only
   * return ["IYaku"], not ["IYaku", "IScorer"]. This requires parser
   * support for interface heritage clauses.
   */
  getAllImplementedInterfaces(className: string): readonly string[] {
    this.ensureCachesClean();
    const cached = this.implementedInterfacesCache.get(className);
    if (cached !== undefined) return cached;
    const result: string[] = [];
    const seen = new Set<string>();
    const visited = new Set<string>();
    let current: string | null = className;
    while (current && !visited.has(current)) {
      visited.add(current);
      const cls = this.classes.get(current);
      if (!cls) break;
      for (const iface of cls.node.implements ?? []) {
        if (!seen.has(iface)) {
          seen.add(iface);
          result.push(iface);
        }
      }
      current = cls.baseClass ?? null;
    }
    this.implementedInterfacesCache.set(className, result);
    return result;
  }

  /**
   * Check if a class implements an interface, including through inheritance.
   * Reads the cache directly when available; falls back to
   * getAllImplementedInterfaces which triggers ensureCachesClean().
   * The public caller (getImplementorsOfInterface) also calls
   * ensureCachesClean() upfront, so stale entries are never consulted.
   */
  private classImplementsInterface(
    className: string,
    interfaceName: string,
  ): boolean {
    const cached = this.implementedInterfacesCache.get(className);
    if (cached !== undefined) return cached.includes(interfaceName);
    return this.getAllImplementedInterfaces(className).includes(interfaceName);
  }

  /** Returns ALL interfaces each class implements, including those
   *  inherited through the base-class chain (via getAllImplementedInterfaces). */
  getClassImplementsMap(): Map<string, readonly string[]> {
    const result = new Map<string, readonly string[]>();
    for (const cls of this.classes.values()) {
      const impls = this.getAllImplementedInterfaces(cls.name);
      if (impls.length > 0) {
        result.set(cls.name, impls);
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
