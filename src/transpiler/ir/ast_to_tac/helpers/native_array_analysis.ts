import {
  ASTNodeKind,
  type ASTNode,
  type ArrayLiteralExpressionNode,
  type AssignmentExpressionNode,
  type BlockStatementNode,
  type CallExpressionNode,
  type CaseClauseNode,
  type DoWhileStatementNode,
  type ForOfStatementNode,
  type ForStatementNode,
  type IdentifierNode,
  type IfStatementNode,
  type PropertyAccessExpressionNode,
  type ReturnStatementNode,
  type SwitchStatementNode,
  type WhileStatementNode,
} from "../../../frontend/types.js";

/**
 * Pre-scans a function/method body to identify local variable names that are
 * ineligible for native array optimization. A variable is ineligible if it:
 *  - Has a dynamic resize method called on it (push, pop, etc.)
 *  - Appears as a direct spread source ([...arr])
 *  - Is passed directly as a function argument
 *  - Is directly returned
 *  - Is directly assigned to a property (this.field = arr)
 *  - Is reassigned (arr = something)
 *  - Is the iterable in a destructured for...of
 *
 * Returns the set of ineligible variable names. Variables not in this set
 * may still be native-array-eligible if their initializer is a constant-length
 * array literal or new Array<T>(N) with a constant N.
 */
export function analyzeNativeArrayIneligibility(body: ASTNode[]): Set<string> {
  const ineligible = new Set<string>();
  for (const stmt of body) {
    collectIneligible(stmt, ineligible);
  }
  return ineligible;
}

function getIdentifierName(node: ASTNode): string | null {
  if (node.kind === ASTNodeKind.Identifier) {
    return (node as IdentifierNode).name;
  }
  return null;
}

function collectIneligible(node: ASTNode | undefined, ineligible: Set<string>): void {
  if (!node) return;

  switch (node.kind) {
    case ASTNodeKind.CallExpression: {
      const call = node as CallExpressionNode;
      if (call.callee.kind === ASTNodeKind.PropertyAccessExpression) {
        const pa = call.callee as PropertyAccessExpressionNode;
        // Any method call on an identifier marks it ineligible for native arrays.
        // Native arrays only support indexed access and .length — no DataList-style
        // methods (push, pop, slice, indexOf, filter, map, etc.) are available.
        const objName = getIdentifierName(pa.object);
        if (objName) ineligible.add(objName);
        collectIneligible(pa.object, ineligible);
      } else {
        collectIneligible(call.callee, ineligible);
      }
      // Any identifier directly passed as an argument escapes scope.
      for (const arg of call.arguments) {
        const argName = getIdentifierName(arg);
        if (argName) ineligible.add(argName);
        collectIneligible(arg, ineligible);
      }
      break;
    }

    case ASTNodeKind.ReturnStatement: {
      const ret = node as ReturnStatementNode;
      if (ret.value) {
        const retName = getIdentifierName(ret.value);
        if (retName) ineligible.add(retName);
        collectIneligible(ret.value, ineligible);
      }
      break;
    }

    case ASTNodeKind.AssignmentExpression: {
      const assign = node as AssignmentExpressionNode;
      // Reassignment of a variable (arr = expr) disqualifies it.
      // Index assignment (arr[i] = v) has ArrayAccessExpression as target — don't disqualify.
      if (assign.target.kind === ASTNodeKind.Identifier) {
        ineligible.add((assign.target as IdentifierNode).name);
      }
      // Property assignment (this.field = arr) — the value escapes.
      // arr.prop = v — the array object is mutated in an unsupported way.
      if (assign.target.kind === ASTNodeKind.PropertyAccessExpression) {
        const pa = assign.target as PropertyAccessExpressionNode;
        // The object of the property setter (e.g. "arr" in arr.length = v) is ineligible.
        const paObjName = getIdentifierName(pa.object);
        if (paObjName) ineligible.add(paObjName);
        // The value being assigned (e.g. "other" in this.field = other) escapes scope.
        const valueName = getIdentifierName(assign.value);
        if (valueName) ineligible.add(valueName);
      }
      collectIneligible(assign.target, ineligible);
      collectIneligible(assign.value, ineligible);
      break;
    }

    case ASTNodeKind.ArrayLiteralExpression: {
      const arr = node as ArrayLiteralExpressionNode;
      for (const elem of arr.elements) {
        if (elem.kind === "spread") {
          const spreadName = getIdentifierName(elem.value);
          if (spreadName) ineligible.add(spreadName);
        }
        collectIneligible(elem.value, ineligible);
      }
      break;
    }

    case ASTNodeKind.ForOfStatement: {
      const forOf = node as ForOfStatementNode;
      // Destructured for...of (for (const [a, b] of arr)) — elements must be DataList.
      if (
        Array.isArray(forOf.variable) ||
        (forOf.destructureProperties && forOf.destructureProperties.length > 0)
      ) {
        const iterName = getIdentifierName(forOf.iterable);
        if (iterName) ineligible.add(iterName);
      }
      collectIneligible(forOf.iterable, ineligible);
      collectIneligible(forOf.body, ineligible);
      break;
    }

    case ASTNodeKind.BlockStatement: {
      const block = node as BlockStatementNode;
      for (const s of block.statements) collectIneligible(s, ineligible);
      break;
    }

    case ASTNodeKind.IfStatement: {
      const ifNode = node as IfStatementNode;
      collectIneligible(ifNode.condition, ineligible);
      collectIneligible(ifNode.thenBranch, ineligible);
      collectIneligible(ifNode.elseBranch, ineligible);
      break;
    }

    case ASTNodeKind.WhileStatement: {
      const w = node as WhileStatementNode;
      collectIneligible(w.condition, ineligible);
      collectIneligible(w.body, ineligible);
      break;
    }

    case ASTNodeKind.DoWhileStatement: {
      const dw = node as DoWhileStatementNode;
      collectIneligible(dw.body, ineligible);
      collectIneligible(dw.condition, ineligible);
      break;
    }

    case ASTNodeKind.ForStatement: {
      const f = node as ForStatementNode;
      collectIneligible(f.initializer, ineligible);
      collectIneligible(f.condition, ineligible);
      collectIneligible(f.incrementor, ineligible);
      collectIneligible(f.body, ineligible);
      break;
    }

    case ASTNodeKind.SwitchStatement: {
      const sw = node as SwitchStatementNode;
      collectIneligible(sw.expression, ineligible);
      for (const c of sw.cases) {
        const clause = c as CaseClauseNode;
        if (clause.expression) collectIneligible(clause.expression, ineligible);
        for (const s of clause.statements) collectIneligible(s, ineligible);
      }
      break;
    }

    default:
      // For all other node types, recurse into known child fields generically.
      recurseChildren(node, ineligible);
      break;
  }
}

/**
 * Fallback: recursively visits any child ASTNode-valued properties of a node.
 * Used for node types not explicitly handled above (e.g. BinaryExpression,
 * UnaryExpression, ConditionalExpression, ExpressionStatement, etc.).
 */
function recurseChildren(node: ASTNode, ineligible: Set<string>): void {
  for (const value of Object.values(node)) {
    if (!value || typeof value !== "object") continue;
    if (typeof (value as ASTNode).kind === "string") {
      collectIneligible(value as ASTNode, ineligible);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && typeof (item as ASTNode).kind === "string") {
          collectIneligible(item as ASTNode, ineligible);
        }
      }
    }
  }
}
