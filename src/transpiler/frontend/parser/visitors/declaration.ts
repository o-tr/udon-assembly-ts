import * as ts from "typescript";
import type { EnumKind } from "../../enum_registry.js";
import {
  ClassTypeSymbol,
  InterfaceTypeSymbol,
  type TypeSymbol,
} from "../../type_symbols.js";
import {
  ASTNodeKind,
  type BlockStatementNode,
  type ClassDeclarationNode,
  type DecoratorNode,
  type EnumDeclarationNode,
  type EnumMemberNode,
  type InterfaceDeclarationNode,
  type MethodDeclarationNode,
  type PropertyDeclarationNode,
  UdonType,
} from "../../types.js";
import type { TypeScriptParser } from "../type_script_parser.js";

export function visitClassDeclaration(
  this: TypeScriptParser,
  node: ts.ClassDeclaration,
): ClassDeclarationNode | undefined {
  if (!node.name) {
    this.reportUnsupportedNode(
      node,
      "Anonymous classes are not supported",
      "Give the class a name.",
    );
    return undefined;
  }

  const className = node.name.text;
  this.typeMapper.registerTypeAlias(
    className,
    new ClassTypeSymbol(className, UdonType.Object),
  );

  const rawDecorators = ts.canHaveDecorators(node)
    ? (ts.getDecorators(node) ?? [])
    : [];
  const decorators = rawDecorators.map((decorator) =>
    this.visitDecorator(decorator),
  );
  const isUdonBehaviourClass = decorators.some(
    (d) => d.name === "UdonBehaviour",
  );

  let baseClass: string | null = null;
  let implementsList: string[] | undefined;
  if (node.heritageClauses) {
    const extendsClause = node.heritageClauses.find(
      (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
    );
    if (extendsClause && extendsClause.types.length > 0) {
      baseClass = extendsClause.types[0]?.expression.getText() ?? null;
    }
    const implementsClause = node.heritageClauses.find(
      (clause) => clause.token === ts.SyntaxKind.ImplementsKeyword,
    );
    if (implementsClause) {
      implementsList = implementsClause.types.map((t) =>
        t.expression.getText(),
      );
    }
  }

  const properties: PropertyDeclarationNode[] = [];
  const methods: MethodDeclarationNode[] = [];
  let constructorNode: ClassDeclarationNode["constructor"];

  const classTypeParams = new Set(
    (node.typeParameters ?? []).map((param) => param.name.getText()),
  );
  if (classTypeParams.size > 0) {
    this.genericTypeParamStack.push(classTypeParams);
  }

  for (const member of node.members) {
    if (ts.isPropertyDeclaration(member)) {
      const property = this.visitPropertyDeclaration(member);
      if (property) properties.push(property);
    } else if (ts.isMethodDeclaration(member)) {
      const method = this.visitMethodDeclaration(member);
      if (method) methods.push(method);
    } else if (ts.isConstructorDeclaration(member)) {
      // First pass: collect @SerializeField params
      const serializeFieldParams = new Set<string>();
      for (const param of member.parameters) {
        const paramDecorators = ts.canHaveDecorators(param)
          ? (ts.getDecorators(param) ?? [])
          : [];
        for (const decorator of paramDecorators) {
          const dec = this.visitDecorator(decorator);
          if (dec.name === "SerializeField") {
            serializeFieldParams.add(param.name.getText());
          }
        }
      }

      if (serializeFieldParams.size > 0 && !isUdonBehaviourClass) {
        throw new Error(
          `@SerializeField on constructor parameters is only allowed in @UdonBehaviour classes, but "${className}" is not decorated with @UdonBehaviour`,
        );
      }

      // Pre-compute property modifier info for each parameter once
      const paramPropertyInfo = member.parameters.map((param) => {
        const hasPropertyModifier =
          param.modifiers?.some(
            (mod) =>
              mod.kind === ts.SyntaxKind.PublicKeyword ||
              mod.kind === ts.SyntaxKind.PrivateKeyword ||
              mod.kind === ts.SyntaxKind.ProtectedKeyword ||
              mod.kind === ts.SyntaxKind.ReadonlyKeyword,
          ) ?? false;
        const paramName = param.name.getText();
        return {
          hasPropertyModifier,
          isParameterProperty:
            hasPropertyModifier || serializeFieldParams.has(paramName),
        };
      });

      // Build params, marking @SerializeField and parameter-property ones.
      // Also capture any `= <default>` initializer AST so saveAndBindInlineParams
      // can emit the default when a caller omits the argument (bug #22).
      const params = member.parameters.map((param, i) => {
        const paramName = param.name.getText();
        const { isParameterProperty } = paramPropertyInfo[i];
        const initializer = param.initializer
          ? this.parseParameterInitializer(param.initializer, param.type)
          : undefined;
        return {
          name: paramName,
          type: param.type ? param.type.getText() : "number",
          ...(serializeFieldParams.has(paramName)
            ? { isSerializeField: true }
            : {}),
          ...(isParameterProperty ? { isParameterProperty: true } : {}),
          ...(initializer ? { initializer } : {}),
        };
      });
      // Register parameters in a wrapping scope so that inferType inside the
      // body can resolve parameter types (e.g. `tiles[0]` where `tiles` is a
      // Tile[] param). Mirrors visitMethodDeclaration; without this, an
      // ElementAccessExpression falls through to mapTypeScriptType("object")
      // = DataDictionary, which corrupts DataToken wrapping for inline-class
      // arrays consumed by constructor bodies.
      let body: BlockStatementNode | undefined;
      if (member.body) {
        this.symbolTable.enterScope();
        for (const param of member.parameters) {
          const paramName = param.name.getText();
          const paramType = param.type
            ? this.mapTypeWithGenerics(param.type.getText(), param.type)
            : this.mapTypeWithGenerics("number");
          this.symbolTable.addSymbol(paramName, paramType, true, false);
        }
        body = this.visitBlock(member.body);
        this.symbolTable.exitScope();
      }
      if (body) {
        constructorNode = {
          parameters: params,
          body,
        };
      }
      for (let i = 0; i < member.parameters.length; i++) {
        const param = member.parameters[i];
        const { hasPropertyModifier, isParameterProperty } =
          paramPropertyInfo[i];
        if (!isParameterProperty) continue;
        const propName = param.name.getText();
        if (properties.some((prop) => prop.name === propName)) continue;
        const propType = param.type
          ? this.mapTypeWithGenerics(param.type.getText(), param.type)
          : this.mapTypeWithGenerics("number");
        const isPublic =
          param.modifiers?.some(
            (mod) => mod.kind === ts.SyntaxKind.PublicKeyword,
          ) ?? !hasPropertyModifier;
        properties.push(
          this.attachLoc(param, {
            kind: ASTNodeKind.PropertyDeclaration,
            name: propName,
            type: propType,
            isPublic,
            isStatic: false,
            isSerializeField: serializeFieldParams.has(propName),
          }),
        );
      }
    } else if (ts.isGetAccessorDeclaration(member)) {
      const propName = member.name.getText();
      // Skip only if an earlier getter for the same name was already
      // registered (duplicate declaration, invalid TS). A preceding setter
      // entry must be upgraded in place: otherwise the setter's bodiless
      // PropertyDeclarationNode stays in `properties` without `isGetter`
      // and a phantom SoA slot gets allocated — the exact bug this fix
      // addresses, just triggered by member ordering.
      const existingIdx = properties.findIndex(
        (prop) => prop.name === propName,
      );
      if (existingIdx !== -1 && properties[existingIdx]?.isGetter) continue;
      const propType = member.type
        ? this.mapTypeWithGenerics(member.type.getText(), member.type)
        : this.mapTypeWithGenerics("object");
      const isStatic = !!member.modifiers?.some(
        (mod) => mod.kind === ts.SyntaxKind.StaticKeyword,
      );
      const isPublic = !!(
        member.modifiers?.some(
          (mod) => mod.kind === ts.SyntaxKind.PublicKeyword,
        ) ?? true
      );
      if (!member.body) {
        this.reportUnsupportedNode(
          member,
          `Abstract getter "${propName}" is not supported`,
          "Provide a concrete getter body.",
        );
        continue;
      }
      this.symbolTable.enterScope();
      const getterBody = this.visitBlock(member.body);
      this.symbolTable.exitScope();
      const getterEntry = this.attachLoc(member, {
        kind: ASTNodeKind.PropertyDeclaration,
        name: propName,
        type: propType,
        isPublic,
        isStatic,
        isGetter: true,
        getterBody,
        getterReturnType: propType,
      });
      if (existingIdx !== -1) {
        properties[existingIdx] = getterEntry;
      } else {
        properties.push(getterEntry);
      }
    } else if (ts.isSetAccessorDeclaration(member)) {
      // NOTE: Setter bodies are currently dropped — PropertyDeclarationNode
      // stores only metadata, not the setter body. A write to this property
      // lands on the plain slot instead of running the setter body, so any
      // validation / side-effect logic in the body is silently lost.
      // Upstream TypeScript blocks writes to a setter-only property when no
      // getter exists, but when a matched getter/setter pair is declared the
      // setter is reachable and this issue becomes user-visible. Warn loudly
      // so the scenario surfaces at transpile time. Full setter-body support
      // requires a write-barrier design and is tracked as follow-up work.
      const propName = member.name.getText();
      if (member.body && member.body.statements.length > 0) {
        const sourceFile = this.sourceFile ?? member.getSourceFile();
        const pos = sourceFile.getLineAndCharacterOfPosition(member.getStart());
        console.warn(
          `SetterBodyUnsupported: Setter "${className}.${propName}" has a body that will be dropped. Writes land directly on the property slot, bypassing any validation or side effects declared inside the setter. Convert to an explicit method (e.g. set${propName[0]?.toUpperCase()}${propName.slice(1)}(v)) to preserve the logic. (${sourceFile.fileName || "<unknown>"}:${pos.line + 1}:${pos.character + 1})`,
        );
      }
      if (properties.some((prop) => prop.name === propName)) continue;
      const param = member.parameters[0];
      const propType = param?.type
        ? this.mapTypeWithGenerics(param.type.getText(), param.type)
        : this.mapTypeWithGenerics("object");
      const isStatic = !!member.modifiers?.some(
        (mod) => mod.kind === ts.SyntaxKind.StaticKeyword,
      );
      const isPublic = !!(
        member.modifiers?.some(
          (mod) => mod.kind === ts.SyntaxKind.PublicKeyword,
        ) ?? true
      );
      properties.push(
        this.attachLoc(member, {
          kind: ASTNodeKind.PropertyDeclaration,
          name: propName,
          type: propType,
          isPublic,
          isStatic,
        }),
      );
    } else if (ts.isIndexSignatureDeclaration(member)) {
    } else {
      this.reportUnsupportedNode(
        member,
        `Unsupported class member: ${ts.SyntaxKind[member.kind]}`,
        "Remove or refactor this class member.",
      );
    }
  }

  if (!isUdonBehaviourClass) {
    const sfProp = properties.find((p) => p.isSerializeField);
    if (sfProp) {
      throw new Error(
        `@SerializeField is only allowed in @UdonBehaviour classes, but "${className}" is not decorated with @UdonBehaviour`,
      );
    }
  }

  const result: ClassDeclarationNode = this.attachLoc(node, {
    kind: ASTNodeKind.ClassDeclaration,
    name: className,
    baseClass,
    implements: implementsList,
    decorators,
    properties,
    methods,
    constructor: constructorNode,
  });

  if (classTypeParams.size > 0) {
    this.genericTypeParamStack.pop();
  }

  return result;
}

/**
 * Extract properties and methods from interface/type-literal members.
 * Handles PropertySignature, MethodSignature, GetAccessorDeclaration,
 * and SetAccessorDeclaration. Shared by visitInterfaceDeclaration and
 * visitTypeAliasDeclaration.
 */
export function extractInterfaceMembers(
  members: ts.NodeArray<ts.TypeElement>,
  mapType: (text: string, node?: ts.TypeNode) => TypeSymbol,
): {
  properties: Array<{ name: string; type: TypeSymbol }>;
  methods: InterfaceDeclarationNode["methods"];
  propertyMap: Map<string, TypeSymbol>;
  methodMap: Map<string, { params: TypeSymbol[]; returnType: TypeSymbol }>;
} {
  const properties: Array<{ name: string; type: TypeSymbol }> = [];
  const methods: InterfaceDeclarationNode["methods"] = [];
  const propertyMap = new Map<string, TypeSymbol>();
  const methodMap = new Map<
    string,
    { params: TypeSymbol[]; returnType: TypeSymbol }
  >();

  for (const member of members) {
    if (ts.isPropertySignature(member) || ts.isGetAccessorDeclaration(member)) {
      const propName = member.name.getText();
      const propType = member.type
        ? mapType(member.type.getText(), member.type)
        : mapType("object");
      const existingIdx = properties.findIndex((p) => p.name === propName);
      if (existingIdx === -1) {
        properties.push({ name: propName, type: propType });
      } else {
        // Getter takes precedence: update the entry pushed by a preceding setter.
        properties[existingIdx] = { name: propName, type: propType };
      }
      propertyMap.set(propName, propType);
    } else if (ts.isMethodSignature(member)) {
      const methodName = member.name.getText();
      const parameters = member.parameters.map((param) => ({
        name: param.name.getText(),
        type: param.type
          ? mapType(param.type.getText(), param.type)
          : mapType("object"),
      }));
      const returnType = member.type
        ? mapType(member.type.getText(), member.type)
        : mapType("void");
      methods.push({ name: methodName, parameters, returnType });
      methodMap.set(methodName, {
        params: parameters.map((param) => param.type),
        returnType,
      });
    } else if (ts.isSetAccessorDeclaration(member)) {
      const propName = member.name.getText();
      const param = member.parameters[0];
      const propType = param?.type
        ? mapType(param.type.getText(), param.type)
        : mapType("object");
      if (!propertyMap.has(propName)) {
        properties.push({ name: propName, type: propType });
        propertyMap.set(propName, propType);
      }
    }
  }

  return { properties, methods, propertyMap, methodMap };
}

export function visitInterfaceDeclaration(
  this: TypeScriptParser,
  node: ts.InterfaceDeclaration,
): InterfaceDeclarationNode {
  const name = node.name.text;
  const { properties, methods, propertyMap, methodMap } =
    extractInterfaceMembers(node.members, (text, typeNode) =>
      this.mapTypeWithGenerics(text, typeNode),
    );

  this.typeMapper.registerTypeAlias(
    name,
    new InterfaceTypeSymbol(name, methodMap, propertyMap),
  );

  return this.attachLoc(node, {
    kind: ASTNodeKind.InterfaceDeclaration,
    name,
    properties,
    methods,
  });
}

export function visitDecorator(
  this: TypeScriptParser,
  node: ts.Decorator,
): DecoratorNode {
  const expression = node.expression;
  if (ts.isCallExpression(expression)) {
    const name = expression.expression.getText();
    const args = expression.arguments.map((arg) => {
      if (ts.isStringLiteral(arg)) {
        return arg.text;
      }
      if (ts.isObjectLiteralExpression(arg)) {
        const result: Record<string, string> = {};
        for (const prop of arg.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const key = prop.name.getText().replace(/^['"]|['"]$/g, "");
          const value = prop.initializer;
          if (ts.isStringLiteral(value)) {
            result[key] = value.text;
          } else {
            result[key] = value.getText().replace(/^['"]|['"]$/g, "");
          }
        }
        return result;
      }
      const text = arg.getText();
      return text.replace(/^['"]|['"]$/g, "");
    });
    return this.attachLoc(node, {
      kind: ASTNodeKind.Decorator,
      name,
      arguments: args,
    });
  }
  return this.attachLoc(node, {
    kind: ASTNodeKind.Decorator,
    name: expression.getText(),
    arguments: [],
  });
}

export function visitPropertyDeclaration(
  this: TypeScriptParser,
  node: ts.PropertyDeclaration,
): PropertyDeclarationNode | undefined {
  if (!node.name) return undefined;
  const name = node.name.getText();

  let type: TypeSymbol = this.mapTypeWithGenerics("number");
  let originalTypeName: string | undefined;
  if (node.type) {
    const typeText = node.type.getText();
    type = this.mapTypeWithGenerics(typeText, node.type);
    originalTypeName = typeText;
  } else if (node.initializer) {
    type = this.inferType(node.initializer);
  }

  const initializer = node.initializer
    ? this.visitExpression(node.initializer)
    : undefined;

  let syncMode: "None" | "Linear" | "Smooth" | undefined;
  let fieldChangeCallback: string | undefined;
  let isSerializeField = false;
  const rawDecorators = ts.canHaveDecorators(node)
    ? (ts.getDecorators(node) ?? [])
    : [];
  for (const decorator of rawDecorators) {
    const dec = this.visitDecorator(decorator);
    if (dec.name === "UdonSynced") {
      const mode = dec.arguments[0];
      if (
        mode === "Linear" ||
        mode === "Smooth" ||
        mode === "None" ||
        mode === undefined
      ) {
        syncMode = (mode ?? "None") as "None" | "Linear" | "Smooth";
      } else if (
        typeof mode === "object" &&
        mode !== null &&
        "syncMode" in (mode as Record<string, string>)
      ) {
        const sync = (mode as Record<string, string>).syncMode;
        if (sync === "Linear" || sync === "Smooth" || sync === "None") {
          syncMode = sync;
        }
      }
    }
    if (dec.name === "FieldChangeCallback") {
      const callback = dec.arguments[0];
      if (typeof callback === "string" && callback.length > 0) {
        fieldChangeCallback = callback;
      }
    }
    if (dec.name === "SerializeField") {
      isSerializeField = true;
    }
  }

  const isStatic = !!node.modifiers?.some(
    (mod) => mod.kind === ts.SyntaxKind.StaticKeyword,
  );
  const isPublic = !!(
    node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.PublicKeyword) ??
    true
  );

  return this.attachLoc(node, {
    kind: ASTNodeKind.PropertyDeclaration,
    name,
    type,
    originalTypeName,
    initializer,
    isPublic,
    isStatic,
    syncMode,
    fieldChangeCallback,
    isSerializeField,
  });
}

export function visitMethodDeclaration(
  this: TypeScriptParser,
  node: ts.MethodDeclaration,
): MethodDeclarationNode | undefined {
  if (!node.name || !node.body) return undefined;
  const name = node.name.getText();

  const methodTypeParams = new Set(
    (node.typeParameters ?? []).map((param) => param.name.getText()),
  );
  if (methodTypeParams.size > 0) {
    this.genericTypeParamStack.push(methodTypeParams);
  }

  const parameters = node.parameters.map((param) => {
    const paramName = param.name.getText();
    const paramType = param.type
      ? this.mapTypeWithGenerics(param.type.getText(), param.type)
      : this.mapTypeWithGenerics("number");
    const initializer = param.initializer
      ? this.parseParameterInitializer(param.initializer, param.type)
      : undefined;
    return {
      name: paramName,
      type: paramType,
      ...(initializer ? { initializer } : {}),
    };
  });

  const returnTypeText = node.type ? node.type.getText() : undefined;
  const returnType =
    returnTypeText !== undefined && node.type !== undefined
      ? this.mapTypeWithGenerics(returnTypeText, node.type)
      : this.mapTypeWithGenerics("void");

  // Register parameters in a wrapping scope so that inferType inside the body
  // can resolve parameter types (e.g. for `let a = tiles[0]` where `tiles` is
  // a Tile[] param). Without this, ElementAccessExpression falls through to
  // mapTypeScriptType("object") = DataDictionary, which corrupts DataToken wrapping.
  this.symbolTable.enterScope();
  for (const param of parameters) {
    this.symbolTable.addSymbol(param.name, param.type, true, false);
  }
  const body = this.visitBlock(node.body);
  this.symbolTable.exitScope();

  const isStatic = !!node.modifiers?.some(
    (mod) => mod.kind === ts.SyntaxKind.StaticKeyword,
  );
  const isPublic = !!(
    node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.PublicKeyword) ??
    true
  );

  const rawDecorators = ts.canHaveDecorators(node)
    ? (ts.getDecorators(node) ?? [])
    : [];
  const decoratorInfos = rawDecorators.map((decorator) =>
    this.visitDecorator(decorator),
  );
  const isRecursive = decoratorInfos.some(
    (decorator) => decorator.name === "RecursiveMethod",
  );
  const isExported = decoratorInfos.some(
    (decorator) => decorator.name === "UdonExport",
  );

  const result: MethodDeclarationNode = this.attachLoc(node, {
    kind: ASTNodeKind.MethodDeclaration,
    name,
    parameters,
    returnType,
    originalReturnTypeName: returnTypeText,
    body,
    isPublic,
    isStatic,
    isRecursive,
    isExported,
  });

  if (methodTypeParams.size > 0) {
    this.genericTypeParamStack.pop();
  }

  return result;
}

export function visitEnumDeclaration(
  this: TypeScriptParser,
  node: ts.EnumDeclaration,
): EnumDeclarationNode {
  const members: EnumMemberNode[] = [];
  let autoValue = 0;
  let enumKind: EnumKind | null = null;
  for (const member of node.members) {
    let value: number | string;
    let memberKind: EnumKind;
    if (member.initializer) {
      const init = evaluateEnumInitializer.call(this, member.initializer);
      value = init.value;
      memberKind = init.kind;
    } else if (enumKind === "string") {
      this.reportTypeError(
        member,
        "String enum members must have string initializers",
        "Add a string initializer to each enum member.",
      );
      value = "";
      memberKind = "string";
    } else {
      value = autoValue;
      memberKind = "number";
    }

    if (enumKind && memberKind !== enumKind) {
      this.reportTypeError(
        member,
        "Mixed string and numeric enum members are not supported",
        "Use either all string or all numeric enum members.",
      );
      continue;
    }

    if (!enumKind) {
      enumKind = memberKind;
    }

    members.push(
      this.attachLoc(member, {
        kind: ASTNodeKind.EnumMember,
        name: member.name.getText(),
        value,
      }),
    );
    if (memberKind === "number" && typeof value === "number") {
      autoValue = value + 1;
    }
  }

  this.enumRegistry.register(
    node.name.text,
    enumKind ?? "number",
    members.map((m) => ({ name: m.name, value: m.value })),
  );

  return this.attachLoc(node, {
    kind: ASTNodeKind.EnumDeclaration,
    name: node.name.text,
    members,
  });
}

function evaluateEnumInitializer(
  this: TypeScriptParser,
  node: ts.Expression,
): { value: number | string; kind: EnumKind } {
  if (ts.isAsExpression(node)) {
    return evaluateEnumInitializer.call(this, node.expression);
  }
  if (ts.isTypeAssertionExpression(node)) {
    return evaluateEnumInitializer.call(this, node.expression);
  }
  if (ts.isParenthesizedExpression(node)) {
    return evaluateEnumInitializer.call(this, node.expression);
  }
  if (ts.isNumericLiteral(node)) {
    return { value: Number(node.text), kind: "number" };
  }
  if (ts.isStringLiteral(node)) {
    return { value: node.text, kind: "string" };
  }
  if (ts.isIdentifier(node)) {
    this.warnEnumInitializer(
      node,
      "Identifier enum initializers are not supported",
    );
    return { value: 0, kind: "number" };
  }
  if (ts.isPrefixUnaryExpression(node)) {
    const inner = evaluateEnumInitializer.call(this, node.operand);
    if (inner.kind !== "number" || typeof inner.value !== "number") {
      this.warnEnumInitializer(
        node,
        "Non-numeric enum initializer is not supported",
      );
      return { value: 0, kind: "number" };
    }
    if (node.operator === ts.SyntaxKind.MinusToken) {
      return { value: -inner.value, kind: "number" };
    }
    if (node.operator === ts.SyntaxKind.PlusToken) {
      return { value: inner.value, kind: "number" };
    }
  }
  this.warnEnumInitializer(node, "Unsupported enum initializer");
  return { value: 0, kind: "number" };
}
