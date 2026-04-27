import type { TypeMapper } from "./type_mapper.js";
import { InterfaceTypeSymbol, type TypeSymbol } from "./type_symbols.js";
import {
  type ASTNode,
  ASTNodeKind,
  type BlockStatementNode,
  type CaseClauseNode,
  type ClassDeclarationNode,
  type DoWhileStatementNode,
  type ForOfStatementNode,
  type ForStatementNode,
  type FunctionDeclarationNode,
  type FunctionExpressionNode,
  type IfStatementNode,
  type MethodDeclarationNode,
  type ObjectLiteralExpressionNode,
  type ProgramNode,
  type PropertyDeclarationNode,
  type SwitchStatementNode,
  type TryCatchStatementNode,
  type VariableDeclarationNode,
  type WhileStatementNode,
} from "./types.js";

/**
 * Post-parse type resolution pass.
 *
 * The parser resolves declared types eagerly via `mapTypeWithGenerics` while
 * visiting each `ts.Node`. For forward-declared interfaces / type aliases
 * (declared later in the same file, or in another file in batch mode), the
 * alias isn't yet registered in `TypeMapper`, so the resolved symbol falls
 * back to a placeholder (`ClassTypeSymbol(name, Object)` / `ObjectType`).
 *
 * After every file has been parsed, every alias is registered. This walker
 * traverses the AST and *upgrades* placeholder types to the registered
 * `InterfaceTypeSymbol` whenever the names match. It also performs the union-
 * member narrowing previously done lazily in the IR phase: for an
 * `ObjectLiteralExpression`-initialized variable / property whose declared
 * type is a union alias, pick the union member whose properties best match
 * the literal's keys.
 *
 * The walk only refines: it never replaces a more specific symbol with a
 * less specific one, so it is safe to invoke repeatedly.
 */
export function resolveDeferredTypes(
  program: ProgramNode,
  typeMapper: TypeMapper,
): void {
  for (const stmt of program.statements) {
    visit(stmt, typeMapper);
  }
}

function upgradeType(type: TypeSymbol, typeMapper: TypeMapper): TypeSymbol {
  if (type instanceof InterfaceTypeSymbol && type.properties.size > 0) {
    return type;
  }
  const name = type.name;
  if (!name) return type;
  const alias = typeMapper.getAlias(name);
  if (alias instanceof InterfaceTypeSymbol && alias.properties.size > 0) {
    return alias;
  }
  return type;
}

function narrowUnionForObjectLiteral(
  type: TypeSymbol,
  initializer: ASTNode | undefined,
  typeMapper: TypeMapper,
): TypeSymbol {
  if (type instanceof InterfaceTypeSymbol && type.properties.size > 0) {
    return type;
  }
  if (
    !initializer ||
    initializer.kind !== ASTNodeKind.ObjectLiteralExpression
  ) {
    return type;
  }
  const name = type.name;
  if (!name) return type;
  const unionParts = typeMapper.getUnionParts(name);
  if (!unionParts) return type;
  const initNode = initializer as ObjectLiteralExpressionNode;
  const objKeys = new Set(
    initNode.properties
      .filter(
        (p): p is { kind: "property"; key: string; value: ASTNode } =>
          p.kind === "property",
      )
      .map((p) => p.key),
  );
  let bestMatch: InterfaceTypeSymbol | undefined;
  let bestMatchSize = 0;
  for (const partType of unionParts) {
    if (
      partType instanceof InterfaceTypeSymbol &&
      partType.properties.size > 0
    ) {
      const partProps = [...partType.properties.keys()];
      if (
        partProps.every((k) => objKeys.has(k)) &&
        partType.properties.size > bestMatchSize
      ) {
        bestMatch = partType;
        bestMatchSize = partType.properties.size;
      }
    }
  }
  return bestMatch ?? type;
}

function visit(node: ASTNode | undefined, typeMapper: TypeMapper): void {
  if (!node) return;
  switch (node.kind) {
    case ASTNodeKind.VariableDeclaration: {
      const v = node as VariableDeclarationNode;
      v.type = upgradeType(v.type, typeMapper);
      v.type = narrowUnionForObjectLiteral(v.type, v.initializer, typeMapper);
      visit(v.initializer, typeMapper);
      return;
    }
    case ASTNodeKind.PropertyDeclaration: {
      const p = node as PropertyDeclarationNode;
      p.type = upgradeType(p.type, typeMapper);
      p.type = narrowUnionForObjectLiteral(p.type, p.initializer, typeMapper);
      if (p.getterReturnType) {
        p.getterReturnType = upgradeType(p.getterReturnType, typeMapper);
      }
      visit(p.initializer, typeMapper);
      visit(p.getterBody, typeMapper);
      return;
    }
    case ASTNodeKind.MethodDeclaration: {
      const m = node as MethodDeclarationNode;
      m.returnType = upgradeType(m.returnType, typeMapper);
      for (const param of m.parameters) {
        param.type = upgradeType(param.type, typeMapper);
        visit(param.initializer, typeMapper);
      }
      visit(m.body, typeMapper);
      return;
    }
    case ASTNodeKind.FunctionDeclaration: {
      const f = node as FunctionDeclarationNode;
      f.returnType = upgradeType(f.returnType, typeMapper);
      for (const param of f.parameters) {
        param.type = upgradeType(param.type, typeMapper);
      }
      visit(f.body, typeMapper);
      return;
    }
    case ASTNodeKind.FunctionExpression: {
      const f = node as FunctionExpressionNode;
      if (f.returnType) {
        f.returnType = upgradeType(f.returnType, typeMapper);
      }
      for (const param of f.parameters) {
        param.type = upgradeType(param.type, typeMapper);
        visit(param.initializer, typeMapper);
      }
      visit(f.body, typeMapper);
      return;
    }
    case ASTNodeKind.ClassDeclaration: {
      const c = node as ClassDeclarationNode;
      for (const prop of c.properties) visit(prop, typeMapper);
      for (const method of c.methods) visit(method, typeMapper);
      if (c.constructor) {
        for (const param of c.constructor.parameters) {
          param.type = upgradeType(param.type, typeMapper);
          visit(param.initializer, typeMapper);
        }
        visit(c.constructor.body, typeMapper);
      }
      return;
    }
    case ASTNodeKind.BlockStatement: {
      const b = node as BlockStatementNode;
      for (const s of b.statements) visit(s, typeMapper);
      return;
    }
    case ASTNodeKind.IfStatement: {
      const s = node as IfStatementNode;
      visit(s.condition, typeMapper);
      visit(s.thenBranch, typeMapper);
      visit(s.elseBranch, typeMapper);
      return;
    }
    case ASTNodeKind.WhileStatement: {
      const s = node as WhileStatementNode;
      visit(s.condition, typeMapper);
      visit(s.body, typeMapper);
      return;
    }
    case ASTNodeKind.DoWhileStatement: {
      const s = node as DoWhileStatementNode;
      visit(s.body, typeMapper);
      visit(s.condition, typeMapper);
      return;
    }
    case ASTNodeKind.ForStatement: {
      const s = node as ForStatementNode;
      visit(s.initializer, typeMapper);
      visit(s.condition, typeMapper);
      visit(s.incrementor, typeMapper);
      visit(s.body, typeMapper);
      return;
    }
    case ASTNodeKind.ForOfStatement: {
      const s = node as ForOfStatementNode;
      if (s.variableType) {
        s.variableType = upgradeType(s.variableType, typeMapper);
      }
      visit(s.iterable, typeMapper);
      visit(s.body, typeMapper);
      return;
    }
    case ASTNodeKind.SwitchStatement: {
      const s = node as SwitchStatementNode;
      visit(s.expression, typeMapper);
      for (const c of s.cases) visit(c, typeMapper);
      return;
    }
    case ASTNodeKind.CaseClause: {
      const c = node as CaseClauseNode;
      if (c.expression) visit(c.expression, typeMapper);
      for (const s of c.statements) visit(s, typeMapper);
      return;
    }
    case ASTNodeKind.TryCatchStatement: {
      const t = node as TryCatchStatementNode;
      visit(t.tryBody, typeMapper);
      visit(t.catchBody, typeMapper);
      visit(t.finallyBody, typeMapper);
      return;
    }
    default:
      return;
  }
}
