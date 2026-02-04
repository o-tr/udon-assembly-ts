import {
  ASTNodeKind,
  type CallExpressionNode,
  type IdentifierNode,
  type PropertyAccessExpressionNode,
} from "./types.js";

const TS_ONLY_CALLEE_NAMES = new Set(["TsOnly", "UdonTsOnly"]);

export const isTsOnlyCallExpression = (call: CallExpressionNode): boolean => {
  if (call.isNew) return false;
  const callee = call.callee;
  if (callee.kind === ASTNodeKind.Identifier) {
    return TS_ONLY_CALLEE_NAMES.has((callee as IdentifierNode).name);
  }
  if (callee.kind === ASTNodeKind.PropertyAccessExpression) {
    return TS_ONLY_CALLEE_NAMES.has(
      (callee as PropertyAccessExpressionNode).property,
    );
  }
  return false;
};
